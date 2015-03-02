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

  var routes = {}
    , trips = {};

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

        var endpoints = [
          { name : 'stops',       endpoint : 'stopsbyroute' },
          { name : 'schedules',   endpoint : 'schedulebyroute' },
          { name : 'predictions', endpoint : 'predictionsbyroute' },
        ];

        endpoints.forEach(function(d){
          get(d.endpoint, { route : id }, function(json){
            route[d.name] = parse(json);
            check();
          });
        });

        function check(){

          var finished = true;
          endpoints.forEach(function(d){
            if (typeof route[d.name] === 'undefined'){
              finished = false;
            }
          });

          if (finished){
            setTimeout(stops.bind(this, index + 1), 1000);
          }
        }
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
    segments: segments,
    stops:    stops,
    routes:   data
  };
}

function poll(data, events){

  // We keep an index of all vehicles so that we can easily track updates.
  // It's better to just push updates down the wire than the entire list of vehicles.
  var vehicles = data.vehicles || {};

  var indexes = {};

  // Index stops by parent_station_name.  We need to do this, because MBTA.
  indexes.stops = _.chain(data.stops)
      .values()
      .indexBy('parent_station_name')
      .value();

  // Index predictions by trip id
  indexes.predictions = _.chain(data.routes)
      .pluck('predictions')
      .pluck('direction')
      .flatten()
      .pluck('trip')
      .flatten()
      .indexBy('trip_id')
      .value();

  // Index schedules by trip id
  indexes.schedules = _.chain(data.routes)
      .pluck('schedules')
      .pluck('direction')
      .flatten()
      .pluck('trip')
      .flatten()
      .indexBy('trip_id')
      .value();

  // Index routes by route id
  indexes.routes = _.indexBy(data.routes, 'route_id');

  (function go(){
    update(function(index){

      var updated = parseVehicles(index, data, indexes)
        , differences = compareVehicles(vehicles, updated);

      console.log(differences.enter.length, differences.exit.length, differences.update.length);
      vehicles = updated;

      setTimeout(go, 1000 * 20);
      data.vehicles = vehicles;
    });
  })();
}

// Munge vehicle and trip updates into something we can use to draw them on the spider map.
// This is a little tricky.  My apologies, future readers.
function parseVehicles(index, data, indexes){

  var arr      = []
    , trips    = _.indexBy(index.trips, function(d){ return d.trip_update.trip.trip_id; })
    , vehicles = _.indexBy(data.vehicles, 'vehicle_id');

  index.vehicles.forEach(function(vehicle){

    var v = vehicle.vehicle
      , trip = trips[v.trip.trip_id];

    var obj = {
      geo : {
        x : v.position.latitude,
        y : v.position.longitude,
        bearing : v.position.bearing
      },
      id : v.vehicle.id,
      ts : v.timestamp.low,
    };

    var trip = trips[v.trip.trip_id] ? trips[v.trip.trip_id].trip_update : false;

    var tid = v.trip.trip_id
      , trip = trips[tid]
      , prediction = indexes.predictions[tid]
      , schedule = indexes.schedules[tid];

    if (trip && trip.trip_update){

      if (prediction){
        obj.prediction = prediction;
      }

      if (schedule){
        console.log('hm');
      } else {
      }
    }


    if (trip){

      var update = trip.stop_time_update;

      if (update && update.length){
        var stop = update.pop();

        if (stop){

          // Check to see if we have an arrival estimate
          if (stop.arrival && stop.arrival.time){
            obj.time = stop.arrival.time.low;
          }

          obj.next = stop.stop_id;
        }
      }
    }

    if (v.vehicle.license_plate){
      obj.plate = v.vehicle.license.plate;
    }

    // var route = routes[v.trip.route_id];

    arr.push(obj);
  });

  return arr;
}


// Find vehicle updates
function compareVehicles(oldIndex, newIndex, indexes){

  var differences = {
    enter:  [],
    exit:   [],
    update: []
  };

  var id;

  // Enter
  for (id in newIndex){
    if (!oldIndex[id]){
      differences.enter.push(id);
    }
  }

  // Exit
  for (id in oldIndex){
    if (!newIndex[id]){
      differences.exit.push(id);
    }
  }

  // Update
  for (id in newIndex){
    var old = oldIndex[id]
      , noo = newIndex[id];

    if (old){

      // See if we have a new stop_id
      if (old.next && old.next !== noo.next){

        // Yay! We can say for sure which segment it's on.
        var last = old.last || [];

        noo.last = last.concat([old.next]);
      }

      if (noo.next && noo.last){

        var origin = noo.last[noo.last.length-1]
          , destination = noo.next;

        var start = indexes.stops[origin]
          , end = indexes.stops[destination];

        console.log(origin, destination, start, end);
      }

      // If our timestamp has been updated, let's treat this like an update.
      if (old.ts !== noo.ts){
        differences.update.push(noo);
      }
    }
  }

  return differences;
}

// Get vehicle locations via protobuf.
function update(callback){

  var builder = ProtoBuf.loadProtoFile('gtfs-realtime.proto')
    , transit = builder.build('transit_realtime')
    , index = {};

  var feeds = [
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
      callback(index);
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
