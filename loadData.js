var http = require('http')
  , qs = require('querystring')
  , _ = require('lodash')
  , log = require('npmlog')
  , fs = require('fs');

// Query everything we need to build the graph and begin doing realtime updates
module.exports = function(options, callback){

  // Try serving cached data first
  fs.readFile('cache.json', 'utf8', function(err, json){
    if (!err){
      log.info('Loading cached subway data.');
      callback(json);
    } else {
      load(options, callback);
    }
  });
}

function load(options, callback){

  var fetch = get.bind(this, options)
    , routes = {};

  // Grab all routes
  fetch('routes/', {}, function(json){

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

        log.info('Loading subway stops... (' + (index + 1) + ' of ' + (routes.length + 1) + ')');

        // Get stops
        fetch('stopsbyroute', { route : id }, function(json){
          route.stops = parse(json, 'stops', id);
          check();
        });

        // Get predictions
        fetch('predictionsbyroute', { route : id }, function(json){
          route.predictions = parse(json, 'prediction', id);
          check();
        });

        // Get schedules
        fetch('schedulebyroute', { route : id }, function(json){
          route.schedule = parse(json, 'schedules', id);
          check();
        });

        // If we have everything, let's proceed to the next route
        function check(){
          if (route.stops && route.predictions && route.schedule){
            setTimeout(stops.bind(this, index + 1), 1000);
          }
        }

      } else {

        // TODO: grab all trains and their locations
        // Done!
        var string = JSON.stringify(routes);
        save(string);
        callback(string);
      }
    })(0);
  });
};

function get(options, endpoint, params, callback){

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
    log.warn('No ' + item + ' for route ' + id);
    return {};
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
