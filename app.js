var http = require('http')
  , log  = require('npmlog')
  , fs   = require('fs')
  , events = new (require('events').EventEmitter)();

var load = require('./load.js')
  , poll = require('./poll.js');

log.enableColor();
log.level = 'verbose';

var options
  , dir = 'public';

try {
  options = require('./config/config.js');
} catch(e){
  log.error('Could not load config');
  process.exit();
}

// Serve static files
var static = require('node-static');
var file = new static.Server('./' + dir);

// Try serving cached data first
fs.readFile('cache.json', 'utf8', function(err, json){
  if (!err){
    log.info('Loading cached data.');
    var data = JSON.parse(json);
    listen(data);
  } else {
    load(function(data){
      log.info('Saving cache.');
      save(JSON.stringify(data));
      listen(data);
    });
  }
});

// Set up HTTP server
function listen(data){

  // Begin updating
  poll(events, data);

  http
    .createServer(function(request, response){

      // Route requests to static files
      if (request.url === '/'){

        // Serve main template
        fs.readFile('index.tmpl', 'utf8', function(err, tmpl){

          // Embed important data on load
          var html = tmpl
            .replace('{{data}}', JSON.stringify(data))
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

  events.on('alerts', update);
  events.on('trips', update);
  events.on('vehicle', update);

  function update(data){
    try {
      var str = JSON.stringify(data);
      ws.send(str);
    } catch(e){
      log.warn('Tried to update websocket, but failed.  Closing socket');
      ws.terminate();
      events.removeListener('alerts', update);
      events.removeListener('trips', update);
      events.removeListener('vehicle', update);
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

function save(data){
  var result = fs.writeFileSync('cache.json', data);
  log.info('Cache file saved.');
}
