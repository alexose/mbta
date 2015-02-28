var http = require('http')
  , qs = require('querystring')
  , _ = require('lodash')
  , log = require('npmlog')
  , fs = require('fs')
  , ProtoBuf = require('protobufjs');

var options;

// Query everything we need to build the graph and begin doing realtime updates
module.exports = function(_options, events, callback){

  options = _options;

  // Try serving cached data first
  fs.readFile('cache.json', 'utf8', function(err, json){
    if (!err){
      log.info('Loading cached subway data.');
      callback(json);

      var data = JSON.parse(json);
      setTimeout(poll.bind(this, data, events), 1000);
    } else {
      load(events, callback);
    }
  });
}

function load(events, callback){

  var routes = {};

  // Grab all routes
  get('routes/', {}, function(json){

    var data = JSON.parse(json);

    var routes = _.chain(data.mode)
      .filter({ mode_name : 'Subway' })
      .pluck('route')
      .flatten()
      .value();

    // Grab stops, schedules, and predictions per route
    (function stops(index){
      var route = routes[index];

      if (route){

        var id = route.route_id;

        log.info('Loading subway routes... (' + (index + 1) + ' of ' + (routes.length + 1) + ')');

        // Get stops
        get('stopsbyroute', { route : id }, function(json){
          route.stops = parse(json);
          setTimeout(stops.bind(this, index + 1), 1000);
        });

      } else {

        // Process main payload and save it
        var obj = segment(routes)
          , string = JSON.stringify(obj);

        // Begin polling vehicle and schedule data
        poll(obj, events);

        save(string);
        callback(string);
      }
    })(0);
  });
};

// Produce a list of segments with which to draw the map
function segment(data){

  var segments = []
    , stops = {}
    , spider = require('./spider.js');

  data.forEach(function(route){
    route.stops.direction.forEach(function(direction){
      direction.stop.forEach(function(stop, i){

        var obj = {};

        // Denormalize route data
        obj.route_id = route.route_id;
        obj.route_name = route.route_name;

        // Provide simplified coordinates
        obj.spider = spider[stop.parent_station];

        // Metadata
        obj.parent_station_name = stop.parent_station_name;
        obj.parent_station = stop.parent_station;

        // Move geo coords
        obj.geo = [
          parseFloat(stop.stop_lon, 10),
          parseFloat(stop.stop_lat, 10)
        ];

        stops[stop.stop_id] = obj;

        var next = direction.stop[i + 1];
        if (next){
          segments.push({
            start : stop.stop_id,
            end : next.stop_id,
            direction : direction.direction_name
          });
        }
      });
    });
  });

  return {
    segments : segments,
    stops : stops,
    routes : data
  };
}

function poll(data, events){

  update(data, events);

  setInterval(function(){
    update(data, events);
  }, 1000 * 10);
}

// Get prediction updates and vehicle locations via protobuf.
function update(data, events){

  var builder = ProtoBuf.loadProtoFile('gtfs-realtime.proto')
    , transit = builder.build('transit_realtime')
    , index = {};

  var feeds = [
    { name : 'alerts',   url : 'http://developer.mbta.com/lib/GTRTFS/Alerts/Alerts.pb' },
    { name : 'trips',    url : 'http://developer.mbta.com/lib/GTRTFS/Alerts/TripUpdates.pb' },
    { name : 'vehicles', url : 'http://developer.mbta.com/lib/GTRTFS/Alerts/VehiclePositions.pb' }
  ];

  // Update each feed
  feeds.forEach(function(feed){
    fetch(feed.url, function(entities){

      index[feed.name] = entities;

      check();

    });
  });

  // Check to see if we're done, and then run the parser.
  function check(){

    var finished = true;
    feeds.forEach(function(feed){
      if (!index[feed.name]){
        finished = false;
      }
    });

    if (finished){
      var vehicles = parseVehicles(index, data);

      var json = JSON.stringify({
          name : feed.name,
          data : entities
        });
      events.emit(feed.name, json);
    }
  }

  function fetch(url, cb){
    http.get(url, function(res){

      var data = [];

      res.on("data", function(chunk) {
        data.push(chunk);
      });

      res.on("end", function() {
        data = Buffer.concat(data);

        var msg = transit.FeedMessage.decode(data);

        if (msg && msg.entity){
          cb(msg.entity);
        } else {
          log.warn('Got .pb file, but there was no data...');
        }
      });
    });
  }

}


// Determine spider map coords of vehicles.
// This is a little tricky.
function parseVehicles(index, data){

  var arr = []
    , routes = _.indexBy(data.routes, 'route_id');

  index.vehicles.forEach(function(vehicle){

    var v = vehicle.vehicle;

    var obj = {
      geo : {
        x : v.position.latitude,
        y : v.position.longitude,
        bearing : v.position.bearing
      },
      id : v.vehicle.id,
      ts : v.timestamp.low
    };

    if (v.vehicle.license_plate){
      obj.plate = v.vehicle.license.plate;
    }

    var route = routes[v.trip.route_id];

    if (route){
      var stopArr = route
        .stops
        .direction[0] // TODO: this is wrong
        .stop
        .map(function(d){
          return data.stops[d.stop_id];
        });

      var latlon = [obj.geo.x, obj.geo.y];
      obj.spider = interpolate(latlon, stopArr);
    }


    arr.push(obj);
  });


  /*
  route.direction.forEach(function(direction, i){
    direction.trip.forEach(function(trip){
      var vehicle = trip.vehicle,


        latlon = [
          parseFloat(obj.geo.x, 10),
          parseFloat(obj.geo.y, 10)
        ];

      obj.spider = interpolate(latlon, stopArr);

      arr.push(obj);
    });
  });
  */

  return arr;
}

// Figure out geo coordinates on spider map
function interpolate(latlon, stops){

  // Determine which two stops on route this point is between
  var segment = closest(latlon, stops)
    , ratio = segment.start.distance / (segment.end.distance + segment.start.distance);

  // Based on the distance ratio, let's find how far we are between the
  // segment that connects start and end
  var x1 = segment.start.stop.spider[0]
    , y1 = segment.start.stop.spider[1]
    , x2 = segment.end.stop.spider[0]
    , y2 = segment.end.stop.spider[1];

  // Calculate vectors
  var x3 = x1 + (x2 - x1) * ratio
    , y3 = y1 + (y2 - y1) * ratio;

  return [x3,y3];
}

// Given a latlon, retrieve closest two stops
function closest(coords, stops){

  var dists = stops.map(function(stop, i){
    return {
      stop : stop,
      distance : distance(coords, stop.geo)
    };
  });

  function sort(a, b){
    return a.distance - b.distance;
  }

  var toptwo = dists.sort(sort).slice(0,2);

  return {
    start : toptwo[0],
    end : toptwo[1]
  };
}

// Determine distance between two coordinate pairs.
// Haversine is probably overkill here, but oh well.
// via http://stackoverflow.com/questions/14560999
function distance(one, two){

  Number.prototype.toRad = function(){
     return this * Math.PI / 180;
  };

  var lat1 = one[0],
    lon1 = one[1],
    lat2 = two[0],
    lon2 = two[1];

  var R = 6371; // km
  //has a problem with the .toRad() method below.
  var x1 = lat2-lat1;
  var dLat = x1.toRad();
  var x2 = lon2-lon1;
  var dLon = x2.toRad();
  var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
                  Math.cos(lat1.toRad()) * Math.cos(lat2.toRad()) *
                  Math.sin(dLon/2) * Math.sin(dLon/2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  var d = R * c;

  return d;
}

function get(endpoint, params, callback){

  params = _.assign({
      api_key: options.api_key,
      format:  'json'
    }, params);

  var settings = {
    host : options.host,
    path : options.path + endpoint + '?' + qs.encode(params)
  };

  // Recieve data and begin listening
  http.get(settings, function(response){

    var str = '';

    response.on('data', function(chunk){
      str += chunk;
    });

    response.on('end', function(){
      callback(str);
    });
  });

};

// Parse JSON into an object
function parse(json){

  try {
    return JSON.parse(json);
  } catch(e){
    return false;
  }
}

function save(routes){
  fs.writeFile('cache.json', routes, function(err) {
    if(err) {
      console.log(err);
    } else {
      console.log("The file was saved!");
    }
  });
}
