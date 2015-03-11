// MBTA viz
var http = require('http')
  , log  = require('npmlog')
  , fs   = require('fs')
  , events = new (require('events').EventEmitter)();

log.enableColor();
log.level = 'verbose';

var options
  , dir = 'bower_components';

try {
  options = require('./config/config.js');
} catch(e){
  log.error('Could not load config');
  process.exit();
}

// Serve static files
var static = require('node-static');
var file = new static.Server('./' + dir);

// Get data
require('./loadData.js')(options, events, listen);

// Set up HTTP server
function listen(data){

  http
    .createServer(function(request, response){

      // Route requests to static files
      if (request.url === '/'){

        // Serve main template
        fs.readFile('index.tmpl', 'utf8', function(err, tmpl){

          // Embed important data on load
          var html = tmpl
            .replace('{{data}}', data)
            .replace('{{socket}}', 'ws://localhost:' + options.socket)
            .replace('{{port}}', options.port);

          respond(response, html, null, 'text/html');
        });

      } else if (request.url.indexOf('/' + dir) === 0){

        request.url = request.url.replace('/' + dir, '');

        // Serve static files
        file.serve(request, response, function (err, result) {
          if (err) {
            log.warn("Error serving " + request.url + " - " + err.message);
            response.writeHead(err.status, err.headers);
            response.end();
          }
        });
      } else {
       respond(response, '', 404);
	  }

    })
    .listen(options.port, function(){
      log.info('Server running on port ' + options.port);
    });
}

// Set up websocket
var WebSocketServer = require('ws').Server
  , wss = new WebSocketServer({ port: options.socket });

wss.on('connection', function connection(ws) {

  log.verbose('Websocket client connected.');

  events.on('alerts', send);
  events.on('trips', send);
  events.on('vehicle', send);

  function send(json){
    try {
      ws.send(json);
    } catch(e){
      log.warn('Tried to update websocket, but failed.  Closing socket');
      ws.terminate();
      events.removeListener('alerts', send);
      events.removeListener('trips', send);
      events.removeListener('vehicle', send);
    }
  }
});

function respond(response, string, code, type){

  code = code || 200;
  type = type || "text/plain";

  response.writeHead(code, {
    "Content-Type": type,
    "Content-Length": string.length
  });
  response.write(string + '\n');
  response.end();
}
