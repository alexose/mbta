/*! tiny Js Pub/Sub
 * http://anasnakawa.com/
 * Copyright (c) Anas Nakawa
 * inspired by Ben Alman's tiny one <https://gist.github.com/cowboy/661855>
 * MIT License
 */
(function( p ) {

  var e = p.e = {};

  p.publish = function( name, data ) {
    ( e[ name ] = e[ name ] || new Event( name ) ).data = data;
    dispatchEvent( e[ name ] );
  };

  p.subscribe = function( name, handler, context ) {
    addEventListener( name, handler.bind( context ) );
  };

  p.unsubscribe = function( name, handler, context ) {
    removeEventListener( name, handler.bind( context ) );
  };

})( this.pubsub = {} );
