var http = require('http')
  , qs = require('querystring')
  , _ = require('lodash')
  , log = require('npmlog');

// Query everything we need to build the graph and begin doing realtime updates
module.exports = function(options, callback){

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

    // Grab stops per route
    (function stops(index){
      var route = routes[index];

      if (route){

        var id = route.route_id;

        log.info('Loading subway stops... (' + (index + 1) + ' of ' + (routes.length + 1) + ')');

        fetch('stopsbyroute', { route : id }, function(json){
          route.stops = JSON.parse(json);
          setTimeout(stops.bind(this, index + 1), 1000);
        });
      } else {

        // TODO: grab all trains and their locations
        // Done!
        callback(JSON.stringify(routes));
      }
    })(0);
  });
};

function get(options, endpoint, params, callback){

  params = _.assign({
      api_key: options.api_key,
      format:  'json'
    }, params);

  console.log(params);

  var settings = {
    host : options.host,
    path : options.path + endpoint + '?' + qs.encode(params)
  };

  // Recieve data and begin listening
  http.get(settings, function(response){

    var str = '';

    response.on('data', function (chunk) {
      str += chunk;
    });

    response.on('end', function () {
      callback(str);
    });
  });

}
