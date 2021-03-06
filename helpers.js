var _ = require('lodash')
  , qs = require('querystring')
  , http = require('http')
  , options = require('./config/config.js');

module.exports = {};

module.exports.makeVehicle = function(obj, indexes){

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

module.exports.get = function get(endpoint, params, callback){

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
module.exports.parse = function parse(json){

  try {
    return JSON.parse(json);
  } catch(e){
    return false;
  }
}

function p(json){
  console.log(JSON.stringify(json, null, 2));
}
