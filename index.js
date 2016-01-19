module.exports = function(config) {
  return {
    producer: require('./lib/producer')(config || {}),
    consumer: require('./lib/consumer')(config || {})
  };
};
