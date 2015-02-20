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
      setTimeout(poll.bind(this, data.routes, events), 1000);
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
          route.stops = parse(json, 'stops', id);
          setTimeout(stops.bind(this, index + 1), 1000);
        });

      } else {

        // Begin polling schedule and prediction data
        poll(routes, events);

        // Process main payload and save it
        var obj = segment(routes)
          , string = JSON.stringify(obj);

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
function poll(routes, events){

  function update(endpoint, index, callback){

    var route = routes[index];
    if (route){

      var id = route.route_id;
      get(endpoint, { route : id }, function(json){

    var obj = parse(json);

        if (obj){

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
        setTimeout(update.bind(this, endpoint, index + 1, callback), 1000);
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
    });
  })();

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
function parse(json, item, id){

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
