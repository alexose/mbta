// MBTA viz
var http = require('http')
  , log  = require('npmlog')
  , fs   = require('fs');

log.enableColor();
log.level = 'warn';

var options;
try {
  options = require('./config/config.js');
} catch(e){
  log.error('Could not load config');
  process.exit();
}

// Serve static files
var static = require('node-static');
var file = new static.Server('./client');

// Get data
require('./loadData.js')(options, listen);

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
            .replace('{{port}}', options.port);

          respond(response, html, null, 'text/html');
        });

      } else if (request.url.indexOf('/client') === 0){

        // Strip /client prefect
        request.url = request.url.replace('/client', '');

        // Serve static files
        file.serve(request, response, function (err, result) {
          if (err) {
            log.warn("Error serving " + request.url + " - " + err.message);
            response.writeHead(err.status, err.headers);
            response.end();
          }
        });
      }

    })
    .listen(options.port, function(){
      log.info('Server running on port ' + options.port);
    });
}

// Serve markup
function main(request, response, data){

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


