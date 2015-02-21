var http = require('http')
  , qs = require('querystring')
  , _ = require('lodash')
  , log = require('npmlog')
  , fs = require('fs');

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
        
        // Begin polling schedule and prediction data
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

// Get prediction updates by route.  These should update every minute
function poll(data, events){

  var routes = data.routes
    , routeIndex = _.indexBy(routes, 'route_id')
    , stopIndex = data.stops;

  function update(endpoint, index, callback, decorator){

    var route = routes[index];
    if (route){

      var id = route.route_id;
      get(endpoint, { route : id }, function(json){

        var obj = parse(json);

        if (obj){

          if (typeof decorator=== 'function'){
            obj = decorator(obj, routeIndex, stopIndex);
          }

          // TODO: prevent all of this unnecessary stringification
          var payload = JSON.stringify({
            name : endpoint,
            data : obj
          });

          events.emit(endpoint, payload);
          log.info('Updated ' + endpoint + ' for route ' + id);
        } else {
          log.info('No info for ' + endpoint + ' for route ' + id);
        }
        setTimeout(update.bind(this, endpoint, index + 1, callback, decorator), 1000);
      });
    } else {
      callback();
    }
  }

  // Get predictions
  (function predictions(){
    update('predictionsbyroute', 0, function(){
      setTimeout(predictions, 1000 * 60);
   });
  })();

  // Get schedules
  (function schedule(){
    update('schedulebyroute', 0, function(){
      setTimeout(schedule, 1000 * 60 * 20);
    });
  })();

  // Get vehicles
  (function vehicles(){
    update('vehiclesbyroute', 0, function(){
      setTimeout(vehicles, 1000 * 20);
    }, parseVehicles);
  })();

}

// Extract vehicles from routes
function parseVehicles(route, routes, stops){

  var arr = [];

  route.direction.forEach(function(direction, i){
    direction.trip.forEach(function(trip){
      var vehicle = trip.vehicle,
        obj = {
          geo : {
            x : parseFloat(vehicle.vehicle_lat, 10),
            y : parseFloat(vehicle.vehicle_lon, 10),
            bearing : parseFloat(vehicle.vehicle_bearing, 10)
          },
          id : vehicle.vehicle_id,
          ts : vehicle.vehicle_timestamp
        };

      var stopArr = routes[route.route_id]
          .stops
          .direction[i]
          .stop 
          .map(function(d){
            return stops[d.stop_id];
          });

        latlon = [
          parseFloat(obj.geo.x, 10),
          parseFloat(obj.geo.y, 10)
        ];

      obj.spider = interpolate(latlon, stopArr);

      arr.push(obj);
    });
  });

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
