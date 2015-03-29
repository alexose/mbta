var  _ = require('lodash')
  , log = require('npmlog')

var helpers = require('./helpers')
  , makeVehicle = helpers.makeVehicle;

var events;

// Now that we've established the main data set, we shall make continual updates to it using protobuf.
module.exports = function(_events, data){

  events = _events;

  // Start listening!
  events.on('vehicle', vehicle.bind(this, data));
};

function vehicle(data, message){

  var vehicle = message.data
    , id = vehicle.id;

  // Overwrite vehicle by ID
  var index = data.vehicles;

  index[id] = vehicle;
}
