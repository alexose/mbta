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
    , trips = {};

  // Grab all routes
  get('routes/', {}, function(json){

    var data = JSON.parse(json);

    var routes = _.chain(data.mode)
      .filter({ mode_name : 'Subway' })
      .pluck('route')
      .flatten()
      .value();

    // Grab stops per route
    (function getStops(pos){
      var route = routes[pos];

      if (route){

        var id = route.route_id;

        log.info('Loading stops for route ' + id + '... (' + (pos + 1) + ' of ' + (routes.length + 1) + ')');

        get('stopsbyroute', { route : id }, function(json){
          route.stops = parse(json);
          setTimeout(getStops.bind(this, pos + 1), 100);
        });
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

  var segments = []
    , spider = require('./spider.js');

  routes.forEach(function(route){
    route.stops.direction.forEach(function(direction){
      direction.stop.forEach(function(stop, i){

        var obj = {};

        obj.id = stop.stop_id;

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

        var next = direction.stop[i + 1];
        if (next){
          segments.push({
            start : stop.stop_id,
            end : next.stop_id,
            direction : direction.direction_name
          });
        }

        // Overwrite object
        direction.stop[i] = obj;
      });
    });
  });

  return {
    routes:      routes,
    segments:    segments,
    predictions: {},
    schedules:   {},
    vehicles:    {}
  };
}

// Now that we've established the main data set, we shall make continual updates to it.
function poll(indexes){

  (function go(){

    update(function(results){

      var trips = results.trips
        , vehicles = results.vehicles;

      // Merge trip updates with prediction index
      processTrips(trips, indexes);

      // Merge vehicle updates with vehicle index
      processVehicles(vehicles, indexes);

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

      getTripInfo('predictions', update.trip, indexes, process.bind(this, trip))
      return;
    }
  });
}

// Munge vehicle and trip updates into something we can use to draw them on the spider map.
// This is a little tricky.  My apologies, future readers.
function processVehicles(vehicles, indexes){

  var missing = {}

  vehicles.forEach(function parse(vehicle){

    var v = vehicle.vehicle
      , id = v.vehicle.id;

    // Ignore vehicles on routes we don't have
    var route = _.find(indexes.routes, { route_id : v.trip.route_id });
    if (!route){
      return;
    }

    var obj = {
      geo : [
        v.position.latitude,
        v.position.longitude,
      ],
      bearing : v.position.bearing,
      id : id,
      ts : v.timestamp.low,
    };

    var tid = v.trip.trip_id
      , prediction = indexes.predictions[tid]
      , schedule = indexes.schedules[tid];

    // Make sure we have predictions and schedules
    ['predictions', 'schedules'].forEach(function(d){

      // First, see if it's already in the index.
      if (indexes[d][tid]){
        obj[d] = indexes[d][tid];
      } else {

        // Next, try to go get it from the API and re-parse
        if (!missing[d]){
          missing[d] = 0;
        }
        missing[d] += 1;

        getTripInfo(d, v.trip, indexes, parse.bind(this, vehicle));
        return;
      }
    });

    // Attempt to figure out coordinates on spider map
    if (schedule){

      // Find segment based on distance
      var stops = _.chain(route.stops.direction).pluck('stop').flatten().value()
        , segment = closest(obj.geo, stops);

      obj.spider = interpolate(obj.geo, segment);
    } else {
      // Assume the vehicle is sitting around at its origin, waiting to leave
    }

    if (v.vehicle.license_plate){
      obj.plate = v.vehicle.license.plate;
    }

    indexes.vehicles[id] = obj;

    var str = JSON.stringify({ name : 'vehicle', data : obj });
    events.emit('vehicle', str);
  });

  log.info(_.keys(indexes.vehicles).length  + ' vehicles, ' + (missing.schedules || 0) + ' without schedules, ' + (missing.predictions || 0) + ' without predictions.');
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

  return [
    toptwo[0].stop,
    toptwo[1].stop
  ];
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

        if (obj){
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
