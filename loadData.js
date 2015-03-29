var http = require('http')
  , qs = require('querystring')
  , _ = require('lodash')
  , log = require('npmlog')
  , fs = require('fs')
  , ProtoBuf = require('protobufjs');

var options, events;

// Query everything we need to build the graph and begin doing realtime updates
module.exports = function(_options, _events, callback){

  options = _options;
  events = _events;

  // Try serving cached data first
  fs.readFile('cache.json', 'utf8', function(err, json){
    if (!err){
      log.info('Loading cached data.');
      callback(json);

      var data = JSON.parse(json);
      setTimeout(poll.bind(this, data), 1000);
    } else {
      load(callback);
    }
  });
}

// We begin by building indexes of all routes and stops
function load(callback){

  var routes = {}
    , trips = {}
    // , whitelist = ["810_", "813_", "823_", "830_", "831_", "840_", "842_", "851_", "852_", "880_", "882_", "899_", "946_", "948_", "903_", "913_", "931_", "933_"];
    // whitelist = ["Green-B", "Green-C", "Green-D", "Green-E", "Mattapan", "Blue", "Orange", "Red"];
    whitelist = ["Blue"];

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
        var indexes = process(routes)
          , string = JSON.stringify(indexes);

        // Begin polling vehicle and schedule data
        poll(indexes);

        save(string);
        callback(string);
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

// Now that we've established the main data set, we shall make continual updates to it.
function poll(indexes){

  (function go(){

    update(function(results){

      var trips = results.trips
        , vehicles = results.vehicles;

      // Merge trip updates with prediction index
      // processTrips(trips, indexes);

      // Merge vehicle updates with vehicle index
      // processVehicles(vehicles, indexes);

      setTimeout(go, 1000 * 30);
    });
  })();
}

// Merge trip (aka prediction) updates into index
function processTrips(trips, indexes){

  trips.forEach(function process(trip){

    var update = trip.trip_update
      , id = update.trip.trip_id
      , times = update.stop_time_update;

    // Ignore trips for routes we don't have
    var route = _.find(indexes.routes, { route_id : update.trip.route_id });
    if (!route){
      return;
    }

    var prediction = indexes.predictions[id];

    if (prediction){

      // Update stop predictions
      times.forEach(function(stop){
        var sequence = stop.stop_sequence;

        if (sequence){
          var found = _.find(prediction.stop, { stop_sequence : sequence.toString() });

          if (found){
            found.arrival = stop.arrival;
          }
        } else {

          // I think this is a trip that hasn't departed yet?
          // TODO: update arrival and departure times?
        }
      });

    } else if (typeof prediction === 'undefined') {

      // getTripInfo('predictions', update.trip, indexes, process.bind(this, trip))
      return;
    }
  });
}

// Munge vehicle and trip updates into something we can use to draw them on the spider map.
// This is a little tricky.  My apologies, future readers.
function processVehicles(vehicles, indexes){

  var missing = {}

  vehicles.forEach(function parse(vehicle){

    console.log(vehicle);

    var v = vehicle.vehicle
      , id = v.vehicle.id;

    var obj = makeVehicle({
      geo : [
        v.position.latitude,
        v.position.longitude,
      ],
      bearing : v.position.bearing,
      id : id,
      ts : v.timestamp.low,
      route_name : route
    }, indexes);

    var str = JSON.stringify({ name : 'vehicle', data : obj });
    events.emit('vehicle', str);
  });

  log.info(_.keys(indexes.vehicles).length  + ' vehicles, ' + (missing.schedules || 0) + ' without schedules, ' + (missing.predictions || 0) + ' without predictions.');
}

function makeVehicle(obj, indexes){

  // Ignore vehicles on routes we don't have
  var route = _.find(indexes.routes, { route_name : obj.route_name });
  if (!route){
    log.warn('No route for vehicle ' + obj.id);
    return false;
  }

  // TODO: improve this logic
  var stops = _.chain(route.stops.direction).flatten().pluck('stop').flatten().value();

  // Dedupe
  stops = _.uniq(stops, function(d){ return d.parent_station; });

  var toptwo = closest(obj.geo, stops)
    , segment = [toptwo[0].stop, toptwo[1].stop];

  obj.spider = interpolate(obj.geo, segment);

  var start = segment[0].parent_station_name
    , end = segment[1].parent_station_name;

  if (start == end){
    obj.current = 'idling at ' + start;
  } else {
    obj.current = 'between ' + start + ' and ' + end;
  }

  return obj;
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

  return toptwo;
}

// This is used to find schedules and predictions for vehicles that don't have them
function getTripInfo(type, trip, indexes, callback){

  var tid = trip.trip_id
    , key = tid + type
    , index = indexes[type];

  var endpoints = {
    predictions : 'predictionsbytrip',
    schedules : 'schedulebytrip'
  }

  // See if this is already in the queue.  If not, add it.
  var entry = _.find(queue, { key : key });

  if (!entry){
    queue.push({
      key : key,
      id : tid,
      type : type,
      trip : trip,
      endpoint : endpoints[type],
      params : { trip : tid },
      callback : callback
    });

    if (queue.length === 1){

      // Start queue
      startQueue(indexes);
    }
  }
}

// Queue meant to limit getTripInfo API requests
var queue = [];
function startQueue(indexes){

  (function go(){

    if (!queue.length){
      save(JSON.stringify(indexes));
      return;
    }

    var entry = queue[0]
      , index = indexes[entry.type]
      , id = entry.id;

    get(entry.endpoint, entry.params, function(json){

      queue.shift();

      var obj = parse(json)
        , rid = entry.trip.route_id
        , route = _.find(indexes.routes, { route_id : rid });

      if (!route){
        index[id] = { response : json };
        log.warn('Route ' + rid + ' not found for ' + id + '.');
      } else {

        if (obj && !obj.error){
          index[id] = obj;

          log.info('Now tracking the ' + obj.trip_name);
          entry.callback();
        } else {
          index[id] = { response : json };
          log.warn('Could not get ' + entry.type + ' for ' + id + ' (' + route.route_name + ').');
        }
      }

      // Fire callback attached to entry
      entry.callback();

      // Continue queue
      indexes[entry.type] = index;

      save(JSON.stringify(indexes));
      setTimeout(go, 50);
      log.verbose(queue.length + ' requests in queue.');
    });
  })();

}


// Get vehicle locations and trip updates via protobuf
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
function interpolate(geo, segment){

  // Calculate distance from each stop
  var dist = {
    next : distance(geo, segment[0].geo),
    prev : distance(geo, segment[1].geo)
  };

  // Determine which two stops on route this point is between
  var ratio = dist.prev / (dist.next + dist.prev);

  // Based on the distance ratio, let's find how far we are between the
  // segment that connects start and end
  var x1 = segment[0].spider[0]
    , y1 = segment[0].spider[1]
    , x2 = segment[1].spider[0]
    , y2 = segment[1].spider[1];

  // Calculate vectors
  var x3 = x1 + (x2 - x1) * ratio
    , y3 = y1 + (y2 - y1) * ratio;

  return [x3,y3];
}

function toDeg(rad){
  return rad * 180 / Math.PI;
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

function save(indexes){
  fs.writeFile('cache.json', indexes, function(err) {
    if(err) {
      log.error(err);
    } else {
      log.info('Cache file saved.');
    }
  });
}

function p(json){
  console.log(JSON.stringify(json, null, 2));
}
