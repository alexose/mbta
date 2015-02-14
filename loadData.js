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

    // Extract all subway lines
    /*
    routes = data.mode
      .filter(function(d){ return d.mode_name === 'Subway'});
    */

    routes = _.flatten(data.mode, true);

    routes = JSON.stringify(routes);
    console.log(routes);
    callback(routes);
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
