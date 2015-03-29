var http = require('http')
  , qs = require('querystring')
  , _ = require('lodash')
  , log = require('npmlog')
  , fs = require('fs')
  , ProtoBuf = require('protobufjs');

var helpers = require('./helpers.js');

var get = helpers.get
  , parse = helpers.parse
  , makeVehicle = helpers.makeVehicle;

var options = require('./config/config.js');

// Query everything we need to build the graph and begin doing realtime updates
module.exports = function(callback){

  var routes = {}
    , trips = {}
    // , whitelist = ["810_", "813_", "823_", "830_", "831_", "840_", "842_", "851_", "852_", "880_", "882_", "899_", "946_", "948_", "903_", "913_", "931_", "933_"];
    whitelist = ["Green-B", "Green-C", "Green-D", "Green-E", "Mattapan", "Blue", "Orange", "Red"];

  // Grab all routes
  get('routes/', {}, function(json){

    var data = JSON.parse(json);

    var routes = _.chain(data.mode)
      .filter(function(d){
        return d.mode_name === 'Subway';
      })
      .pluck('route')
      .flatten()
      .filter(function(d){
        return whitelist.indexOf(d.route_id) !== -1;
      })
      .value();

    // Grab stops per route
    (function getStops(pos){
      var route = routes[pos];

      if (route){

        var id = route.route_id;

        log.info('Loading stops for route ' + id + '... (' + (pos + 1) + ' of ' + (routes.length) + ')');

        get('stopsbyroute', { route : id }, function(json){

          route.stops = parse(json);
          check();
        });

        get('schedulebyroute', { route : id }, function(json){
          route.schedules = parse(json);
          check();
        });

        get('vehiclesbyroute', { route : id }, function(json){
          route.vehicles = parse(json);
          check();
        });

        function check(){
          if (route.stops && route.schedules && route.vehicles){
            setTimeout(getStops.bind(this, pos + 1), 100);
          }
        }
      } else {

        // Process main payload and save it
        var indexes = process(routes);

        // Begin polling vehicle and schedule data
        callback(indexes);
      }
    })(0);
  });
};

// Produce a list of segments with which to draw the map.  Also build indexes.
function process(routes){

  var segments = {}
    , index = {}
    , schedules = {}
    , vehicles = {}
    , spider = require('./spider.js');

  routes.forEach(function(route, i){
    var name = route.route_name
      , id = route.route_id;

    // Use trips to determine segments
    _.chain(route.schedules.direction).pluck('trip').flatten().value().forEach(function(trip){

      schedules[trip.trip_id] = trip;

      trip.stop.forEach(function(stop, i){

        // Find the next stop in the sequence
        var next = trip.stop[i + 1];

        if (next){
          var start = stop.stop_id
            , end = next.stop_id;

          segments[start + '-' + end] = {
            start : start,
            end : end,
            route: id,
            trip: trip.trip_id
          };
        }
      });
    });

    // Index vehicles
    if (route.vehicles.direction){
      route.vehicles.direction.forEach(function(direction, i){
        direction.trip.forEach(function(trip){
          var id = trip.vehicle.vehicle_id;

          trip.direction_id = direction.direction_id;
          trip.route_name = route.route_name;

          vehicles[id] = trip;
        });
      });
    }

    // Fix stop coordinates
    var stops = _.chain(route.stops.direction).pluck('stop').flatten().value();

    stops.forEach(function(stop){

        // Provide simplified coordinates
        stop.spider = spider[stop.parent_station];

        // Move geo coords
        stop.geo = [
          parseFloat(stop.stop_lat, 10),
          parseFloat(stop.stop_lon, 10)
        ];

        delete stop.stop_lat;
        delete stop.stop_lon;

        // Add to stop index.  This is needed for lookups elsewhere.
        index[stop.stop_id] = stop;
    });
  });

  var indexes = {
    routes:      routes,
    segments:    _.values(segments),
    stops:       index,
    predictions: {},
    schedules:   schedules,
    vehicles:    {}
  };

  for (var id in vehicles){
    var v = vehicles[id];

    var obj = makeVehicle({
      geo : [
        parseFloat(v.vehicle.vehicle_lat, 10),
        parseFloat(v.vehicle.vehicle_lon, 10)
      ],
      bearing : v.vehicle.vehicle_bearing,
      id : id,
      ts : v.vehicle.vehicle_timestamp,
      trip_name : v.trip_name,
      route_name : v.route_name
    }, indexes);

    indexes.vehicles[id] = obj;
  }

  return indexes;
}
