var initialized = false;

var colors = {
  'Green Line':       'rgb(51, 160, 44)',
  'Red Line':         'rgb(227, 26, 28)',
  'Orange Line':      'rgb(255, 127, 0)',
  'Blue Line':        'rgb(31, 120, 180)',
  'Mattapan Trolley': 'rgb(227, 26, 28)'
};

// Initialize function to be run when data is ready
init();

function init(){

  // Process stops
  var stops = _.chain(data.routes)
    .pluck('stops')
    .pluck('direction')
    .flatten()
    .pluck('stop')
    .flatten()
    .value();

  var coords = 'spider';

  // Create index
  var index = _.indexBy(stops, 'id');

  // Make scale and extent
  var extent = makeExtent(index, coords);
  var scale = makeScale(extent);

  stops.forEach(function(d){
    d.x = scale.x(d[coords][0]);
    d.y = scale.y(d[coords][1]);
    d.color = colors[d.route_name];
  });

  // Process stations
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

  // Process segments
  var segments = data.segments;
  segments.forEach(function(d){
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

  // Process vehicles
  var vehicles = _.values(data.vehicles);

  vehicles.forEach(function(d){
    if (d[coords]){
      d.x = scale.x(d[coords][0]);
      d.y = scale.y(d[coords][1]);
    }
  });

  initialized = true;

  lineFunction = lineFunction.bind(this, index, stations);

  // Ready to draw!
  draw(stops, segments, vehicles);
}

function makeExtent(index, coords){
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

function makeScale(extent){
  var padding = 2;
  return {
    x : d3.scale.linear().domain(extent[0]).range([0 + padding, 100 - padding]),
    y : d3.scale.linear().domain(extent[1]).range([0 + padding, 100 - padding])
  }
}


function draw(stops, segments, vehicles){

  var svg = d3.selectAll('svg');

  var circles = svg.selectAll('circle'),
      lines = svg.selectAll('line'),
      rects = svg.selectAll('rect');

  circles
    .data(stops)
    .enter()
      .append('circle')
        .on('mouseover', mouseover)
        .style('fill', function(d){ return d.color; });

  lines
    .data(segments)
    .enter()
      .append('path')
        .style('fill', function(d){ return d.color; })
        .style('stroke', 'black')
        .style('stroke-width', 0.1);

  update(0);

  function mouseover(stop){
    console.log(stop.parent_station_name, stop);
  }

}

// Transition-based update
function update(time){

  time = time || 1000;

  var svg = d3.selectAll('svg');

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

// Set up socket
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

function lineFunction(index, stations, d){
  var p1 = d.segment[0];
  var p2 = d.segment[1];
  var offsets = offsetPoints(d);
  var p3 = offsets[1];
  var p4 = offsets[0];
  var first;

  var stop = {
    start : index[d.start],
    end : index[d.end]
  };

  var station = {
    start : stations[stop.start.parent_station + stop.start.route_name],
    end : stations[stop.end.parent_station + stop.end.route_name],
  };

  first = closestClockwise(d, station.end.outgoing);
  if (first) {
    var outgoingPoints = offsetPoints(first);
    var newP3 = intersect(offsets, outgoingPoints);
    if (newP3) { p3 = newP3; }
  }
  first = closestCounterClockwise(d, station.start.incoming);
  if (first) {
    var incomingPoints = offsetPoints(first);
    var newP4 = intersect(offsets, incomingPoints);
    if (newP4) { p4 = newP4; }
  }

  return d3.svg.line()
    .x(function(d) { return d[0]; })
    .y(function(d) { return d[1]; })
    .interpolate("linear")([p1, p2, p3, p4, p1]);
}

