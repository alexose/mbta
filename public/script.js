var stops = _.chain(data.routes)
  .pluck('stops')
  .pluck('direction')
  .flatten()
  .pluck('stop')
  .flatten()
  .value();

var index = _.indexBy(stops, 'id');

var stations = _.chain(stops)
  .map(function(d){
    var obj = {
      incoming : [],
      outgoing : []
    }
    return [ d.parent_station + d.route_name, obj ]
  })
  .zipObject()
  .value()

var segments = data.segments;

var vehicles = _.values(data.vehicles);

var svg = d3.selectAll('svg');

// Map colors
var colors = {
  'Green Line':       'rgb(51, 160, 44)',
  'Red Line':         'rgb(227, 26, 28)',
  'Orange Line':      'rgb(255, 127, 0)',
  'Blue Line':        'rgb(31, 120, 180)',
  'Mattapan Trolley': 'rgb(227, 26, 28)'
};

function makeExtent(){
  var arr = _.chain(index)
    .pluck(coords)
    .value();

  var x = _.chain(arr).pluck(0).value(),
    y = _.chain(arr).pluck(1).value();

  var obj = [
      [_.min(x), _.max(x)],
      [_.min(y), _.max(y)]
    ];

  // TODO: fix this stuff
  if (coords == 'geo'){
    obj[1].reverse();
  } else if (coords == 'spider'){

    // Add more vertical padding
    obj[1][0] -= 3;
    obj[1][1] += 3;
  }

  return obj;
};

// Create a graph of stations with to-and-from segments
function makeGraph(){

  data.segments.forEach(function(d){
    var stop = {
        start : index[d.start],
        end : index[d.end]
      },
      route = stop.start.route_name,
      station = {
        start : stations[stop.start.parent_station + route],
        end : stations[stop.end.parent_station + route]
      };

    d.segment = [
      [stop.start.x, stop.start.y],
      [stop.end.x, stop.end.y]
    ];

    d.color = colors[stop.start.route_name] || '#333';

    if (station.start){
      station.start.outgoing.push(d);
    } if (station.end){
      station.end.incoming.push(d);
    }
  });
}

var lineMapping = d3.svg.line()
  .x(function(d) { return d[0]; })
  .y(function(d) { return d[1]; })
  .interpolate("linear");

function makeScale(){
  var padding = 2;
  return {
    x : d3.scale.linear().domain(extent[0]).range([0 + padding, 100 - padding]),
    y : d3.scale.linear().domain(extent[1]).range([0 + padding, 100 - padding])
  }
}

function mouseover(stop){
  console.log(stop.parent_station_name, stop);
}

var coords, extent, scale, initialized;

var dist = 1.4;

init();
function init(){
  coords = coords === 'spider' ? 'geo' : 'spider';
  extent = makeExtent();
  scale = makeScale();

  // Processs coordinates
  stops.forEach(function(d){
    d.x = scale.x(d[coords][0]);
    d.y = scale.y(d[coords][1]);
  });

  // Processs coordinates
  vehicles.forEach(function(d){
    if (d[coords]){
      d.x = scale.x(d[coords][0]);
      d.y = scale.y(d[coords][1]);
    }
  });

  makeGraph();

  if (initialized){
    update();
  } else {
    draw(stops, segments, vehicles);
  }
  initialized = true;
}

function draw(stops, segments, vehicles){

  var circles = svg.selectAll('circle'),
      lines = svg.selectAll('line'),
      rects = svg.selectAll('rect');

  circles
    .data(stops)
    .enter()
      .append('circle')
        .on('mouseover', mouseover)
        .style('fill', function(d){ return colors[d.route_name]; });

  lines
    .data(segments)
    .enter()
      .append('path')
        .style('fill', function(d){ return d.color; })
        .style('stroke', 'black')
        .style('stroke-width', 0.1);

  update(0);
}

function update(time){

  time = time || 1000;

  var circles = svg.selectAll('circle'),
      lines = svg.selectAll('path'),
      rects = svg.selectAll('rect');

  circles
    .transition().duration(time)
      .attr('cy', function(d){ return d.y })
      .attr('cx', function(d){ return d.x })
      .attr('r', 1);

  lines
    .transition().duration(time)
      .attr('d', lineFunction);

  rects
    .data(vehicles)
    .enter()
      .append('rect')
        .transition().duration(time)
          .attr('width', 1)
          .attr('height', 1)
          .attr('x', function(d){ return d.x; })
          .attr('y', function(d){ return d.y; });
}

// Set up web socket
var ws = new WebSocket('{{socket}}');

ws.onopen = function(){
  console.log('Socket opened.');
};

ws.onmessage = function(message){
  var data = parse(message.data);
  pubsub.publish(data.name, data.data);
};

pubsub.subscribe('vehicle', function(e){

  var vehicle = e.data;

  // Processs coordinates
  if (vehicle[coords]){
    vehicle.x = scale.x(vehicle[coords][0]);
    vehicle.y = scale.y(vehicle[coords][1]);
  } else {
    vehicle.draw = false;
  }

  // Update vehicles array
  var pos = _.findIndex(vehicles, { id : vehicle.id });

  if (pos !== -1){
    vehicles[pos] = vehicle;
  } else {
    vehicles.push(vehicle);
  }

  update(10000);
});

function parse(json){
  try{
    return JSON.parse(json);
  } catch(e){
    console.log('Couldn\'t parse JSON via websocket.');
  }
}
