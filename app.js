// MBTA viz
var http = require('http')
  , log  = require('npmlog')
  , fs   = require('fs')
  , qs   = require('querystring');

log.enableColor();
log.level = "verbose";

var options;
try {
  options = require('./config/config.js');
} catch(e){
  log.error('Could not load config');
  process.exit();
}

// Get stops data
var host = 'realtime.mbta.com'
  , path = '/developer/api/v2/'
  , stops = 'stopsbylocation/';

var params = {
  api_key: options.api_key,
  lat:     42.346961,
  lon:     -71.076640,
  format:  'json'
};

var settings = {
  host : host,
  path : path + stops + '?' + qs.encode(params)
}

console.log(settings);

// Recieve data and begin listening
http.get(settings, function(response){

  var str = '';

  response.on('data', function (chunk) {
    str += chunk;
  });

  response.on('end', function () {
    init(str);
  });
});

// Set up HTTP server
function init(data){

  http
    .createServer(function(request, response){
		main(request, response, data);
	})
    .listen(options.port, function(){
      log.info('Server running on port ' + options.port);
    });
}

// Serve markup
function main(request, response, data){

  fs.readFile('index.tmpl', 'utf8', function(err, tmpl){

    // Embed important data on load
    var html = tmpl
      .replace('{{data}}', data)
      .replace('{{port}}', options.port);

    respond(response, html, null, 'text/html');
  });
}

// Set up websocket
var WebSocketServer = require('ws').Server
  , wss = new WebSocketServer({ port: options.socket });

wss.on('connection', function connection(ws) {
  ws.on('message', function incoming(message) {
  });

  ws.send('connected');
});


function respond(response, string, code, type){

  code = code || 200;
  type = type || "text/plain";

  log.verbose(code + ': ' + string);

  response.writeHead(code, {
    "Content-Type": type,
    "Content-Length": string.length
  });
  response.write(string + '\n');
  response.end();
}


