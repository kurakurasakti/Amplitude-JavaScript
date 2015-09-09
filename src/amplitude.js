var Cookie = require('./cookie');
var JSON = require('json'); // jshint ignore:line
var language = require('./language');
var localStorage = require('./localstorage');  // jshint ignore:line
var md5 = require('JavaScript-MD5');
var object = require('object');
var Request = require('./xhr');
var UAParser = require('ua-parser-js');
var UUID = require('./uuid');
var version = require('./version');
var Identify = require('./identify');

var log = function(s) {
  console.log('[Amplitude] ' + s);
};

var IDENTIFY_EVENT = '$identify';
var API_VERSION = 2;
var MAX_STRING_LENGTH = 1024;
var DEFAULT_OPTIONS = {
  apiEndpoint: 'api.amplitude.com',
  cookieExpiration: 365 * 10,
  cookieName: 'amplitude_id',
  domain: undefined,
  includeUtm: false,
  language: language.language,
  optOut: false,
  platform: 'Web',
  savedMaxCount: 1000,
  saveEvents: true,
  sessionTimeout: 30 * 60 * 1000,
  unsentKey: 'amplitude_unsent',
  unsentIdentifyKey: 'amplitude_unsent_identify',
  uploadBatchSize: 100,
  batchEvents: false,
  eventUploadThreshold: 30,
  eventUploadPeriodMillis: 30 * 1000 // 30s
};
var LocalStorageKeys = {
  LAST_EVENT_ID: 'amplitude_lastEventId',
  LAST_IDENTIFY_ID: 'amplitude_lastIdentifyId',
  LAST_EVENT_TIME: 'amplitude_lastEventTime',
  SESSION_ID: 'amplitude_sessionId'
};

/*
 * Amplitude API
 */
var Amplitude = function() {
  this._unsentEvents = [];
  this._unsentIdentifys = [];
  this._ua = new UAParser(navigator.userAgent).getResult();
  this.options = object.merge({}, DEFAULT_OPTIONS);
};

Amplitude.prototype._eventId = 0;
Amplitude.prototype._identifyId = 0;
Amplitude.prototype._sending = false;
Amplitude.prototype._lastEventTime = null;
Amplitude.prototype._sessionId = null;
Amplitude.prototype._newSession = false;

Amplitude.prototype.Identify = Identify;

/**
 * Initializes Amplitude.
 * apiKey The API Key for your app
 * opt_userId An identifier for this user
 * opt_config Configuration options
 *   - saveEvents (boolean) Whether to save events to local storage. Defaults to true.
 *   - includeUtm (boolean) Whether to send utm parameters with events. Defaults to false.
 *   - includeReferrer (boolean) Whether to send referrer info with events. Defaults to false.
 */
Amplitude.prototype.init = function(apiKey, opt_userId, opt_config) {
  try {
    this.options.apiKey = apiKey;
    if (opt_config) {
      if (opt_config.saveEvents !== undefined) {
        this.options.saveEvents = !!opt_config.saveEvents;
      }
      if (opt_config.domain !== undefined) {
        this.options.domain = opt_config.domain;
      }
      if (opt_config.includeUtm !== undefined) {
        this.options.includeUtm = !!opt_config.includeUtm;
      }
      if (opt_config.includeReferrer !== undefined) {
        this.options.includeReferrer = !!opt_config.includeReferrer;
      }
      if (opt_config.batchEvents !== undefined) {
        this.options.batchEvents = !!opt_config.batchEvents;
      }
      this.options.platform = opt_config.platform || this.options.platform;
      this.options.language = opt_config.language || this.options.language;
      this.options.sessionTimeout = opt_config.sessionTimeout || this.options.sessionTimeout;
      this.options.uploadBatchSize = opt_config.uploadBatchSize || this.options.uploadBatchSize;
      this.options.eventUploadThreshold = opt_config.eventUploadThreshold || this.options.eventUploadThreshold;
      this.options.savedMaxCount = opt_config.savedMaxCount || this.options.savedMaxCount;
      this.options.eventUploadPeriodMillis = opt_config.eventUploadPeriodMillis || this.options.eventUploadPeriodMillis;
    }

    Cookie.options({
      expirationDays: this.options.cookieExpiration,
      domain: this.options.domain
    });
    this.options.domain = Cookie.options().domain;

    _loadCookieData(this);

    this.options.deviceId = (opt_config && opt_config.deviceId !== undefined &&
        opt_config.deviceId !== null && opt_config.deviceId) ||
        this.options.deviceId || UUID();
    this.options.userId = (opt_userId !== undefined && opt_userId !== null && opt_userId) || this.options.userId || null;
    _saveCookieData(this);

    //log('initialized with apiKey=' + apiKey);
    //opt_userId !== undefined && opt_userId !== null && log('initialized with userId=' + opt_userId);

    if (this.options.saveEvents) {
      var savedUnsentEventsString = localStorage.getItem(this.options.unsentKey);
      if (savedUnsentEventsString) {
        try {
          this._unsentEvents = JSON.parse(savedUnsentEventsString);
        } catch (e) {
          //log(e);
        }
      }
      var savedUnsentIdentifysString = localStorage.getItem(this.options.unsentIdentifyKey);
      if (savedUnsentIdentifysString) {
        try {
          this._unsentIdentifys = JSON.parse(savedUnsentIdentifysString);
        } catch (e) {
          //log(e);
        }
      }
    }

    this._sendEventsIfReady();

    if (this.options.includeUtm) {
      this._initUtmData();
    }

    this._lastEventTime = parseInt(localStorage.getItem(LocalStorageKeys.LAST_EVENT_TIME)) || null;
    this._sessionId = parseInt(localStorage.getItem(LocalStorageKeys.SESSION_ID)) || null;
    this._eventId = localStorage.getItem(LocalStorageKeys.LAST_EVENT_ID) || 0;
    this._identifyId = localStorage.getItem(LocalStorageKeys.LAST_IDENTIFY_ID) || 0;
    var now = new Date().getTime();
    if (!this._sessionId || !this._lastEventTime || now - this._lastEventTime > this.options.sessionTimeout) {
      this._newSession = true;
      this._sessionId = now;
      localStorage.setItem(LocalStorageKeys.SESSION_ID, this._sessionId);
    }
    this._lastEventTime = now;
    localStorage.setItem(LocalStorageKeys.LAST_EVENT_TIME, this._lastEventTime);
  } catch (e) {
    log(e);
  }
};

Amplitude.prototype.isNewSession = function() {
  return this._newSession;
};

Amplitude.prototype.nextEventId = function() {
  this._eventId++;
  return this._eventId;
};

Amplitude.prototype.nextIdentifyId = function() {
  this._identifyId++;
  return this._identifyId;
};

// returns the number of unsent events and identifys
Amplitude.prototype._unsentCount = function() {
  return this._unsentEvents.length + this._unsentIdentifys.length;
};

// returns true if sendEvents called immediately
Amplitude.prototype._sendEventsIfReady = function(callback) {
  if (this._unsentCount() === 0) {
    return false;
  }

  if (!this.options.batchEvents) {
    this.sendEvents(callback);
    return true;
  }

  if (this._unsentCount() >= this.options.eventUploadThreshold) {
    this.sendEvents(callback);
    return true;
  }

  setTimeout(this.sendEvents.bind(this), this.options.eventUploadPeriodMillis);
  return false;
};

var _loadCookieData = function(scope) {
  var cookieData = Cookie.get(scope.options.cookieName);
  if (cookieData) {
    if (cookieData.deviceId) {
      scope.options.deviceId = cookieData.deviceId;
    }
    if (cookieData.userId) {
      scope.options.userId = cookieData.userId;
    }
    if (cookieData.optOut !== undefined) {
      scope.options.optOut = cookieData.optOut;
    }
  }
};

var _saveCookieData = function(scope) {
  Cookie.set(scope.options.cookieName, {
    deviceId: scope.options.deviceId,
    userId: scope.options.userId,
    optOut: scope.options.optOut
  });
};

Amplitude._getUtmParam = function(name, query) {
  name = name.replace(/[\[]/, "\\[").replace(/[\]]/, "\\]");
  var regex = new RegExp("[\\?&]" + name + "=([^&#]*)");
  var results = regex.exec(query);
  return results === null ? undefined : decodeURIComponent(results[1].replace(/\+/g, " "));
};

Amplitude._getUtmData = function(rawCookie, query) {
  // Translate the utmz cookie format into url query string format.
  var cookie = rawCookie ? '?' + rawCookie.split('.').slice(-1)[0].replace(/\|/g, '&') : '';

  var fetchParam = function (queryName, query, cookieName, cookie) {
    return Amplitude._getUtmParam(queryName, query) ||
           Amplitude._getUtmParam(cookieName, cookie);
  };

  return {
    utm_source: fetchParam('utm_source', query, 'utmcsr', cookie),
    utm_medium: fetchParam('utm_medium', query, 'utmcmd', cookie),
    utm_campaign: fetchParam('utm_campaign', query, 'utmccn', cookie),
    utm_term: fetchParam('utm_term', query, 'utmctr', cookie),
    utm_content: fetchParam('utm_content', query, 'utmcct', cookie),
  };
};

/**
 * Parse the utm properties out of cookies and query for adding to user properties.
 */
Amplitude.prototype._initUtmData = function(queryParams, cookieParams) {
  queryParams = queryParams || location.search;
  cookieParams = cookieParams || Cookie.get('__utmz');
  this._utmProperties = Amplitude._getUtmData(cookieParams, queryParams);
};

Amplitude.prototype._getReferrer = function() {
  return document.referrer;
};

Amplitude.prototype._getReferringDomain = function() {
  var parts = this._getReferrer().split("/");
  if (parts.length >= 3) {
    return parts[2];
  }
  return "";
};

Amplitude.prototype.saveEvents = function() {
  try {
    localStorage.setItem(this.options.unsentKey, JSON.stringify(this._unsentEvents));
    localStorage.setItem(this.options.unsentIdentifyKey, JSON.stringify(this._unsentIdentifys));
  } catch (e) {
    //log(e);
  }
};

Amplitude.prototype.setDomain = function(domain) {
  try {
    Cookie.options({
      domain: domain
    });
    this.options.domain = Cookie.options().domain;
    _loadCookieData(this);
    _saveCookieData(this);
    //log('set domain=' + domain);
  } catch (e) {
    log(e);
  }
};

Amplitude.prototype.setUserId = function(userId) {
  try {
    this.options.userId = (userId !== undefined && userId !== null && ('' + userId)) || null;
    _saveCookieData(this);
    //log('set userId=' + userId);
  } catch (e) {
    log(e);
  }
};

Amplitude.prototype.setOptOut = function(enable) {
  try {
    this.options.optOut = enable;
    _saveCookieData(this);
    //log('set optOut=' + enable);
  } catch (e) {
    log(e);
  }
};

Amplitude.prototype.setDeviceId = function(deviceId) {
  try {
    if (deviceId) {
      this.options.deviceId = ('' + deviceId);
      _saveCookieData(this);
    }
  } catch (e) {
    log(e);
  }
};

Amplitude.prototype.setUserProperties = function(userProperties) {

  // convert userProperties into an identify call
  var identify = new Identify();
  for (var property in userProperties) {
    if (userProperties.hasOwnProperty(property)) {
      identify.set(property, userProperties[property]);
    }
  }

  // _saveCookieData(this); ??
  this.identify(identify);
};

Amplitude.prototype.identify = function(identify) {
  if (identify instanceof Identify) {
    this._logEvent(IDENTIFY_EVENT, null, null, identify.userPropertiesOperations);
  }
};

Amplitude.prototype.setVersionName = function(versionName) {
  try {
    this.options.versionName = versionName;
    //log('set versionName=' + versionName);
  } catch (e) {
    log(e);
  }
};

// truncate string values in event and user properties so that request size does not get too large
Amplitude.prototype._truncate = function(value) {
  if (typeof(value) === 'object') {
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        value[i] = this._truncate(value[i]);
      }
    } else {
      for (var key in value) {
        if (value.hasOwnProperty(key)) {
          value[key] = this._truncate(value[key]);
        }
      }
    }

    return value;
  }

  return _truncateValue(value);
};

var _truncateValue = function(value) {
  if (typeof(value) === 'string') {
    return value.length > MAX_STRING_LENGTH ? value.substring(0, MAX_STRING_LENGTH) : value;
  }
  return value;
};

/**
 * Private logEvent method. Keeps apiProperties from being publicly exposed.
 */
Amplitude.prototype._logEvent = function(eventType, eventProperties, apiProperties, userProperties, callback) {
  if (typeof callback !== 'function') {
    callback = null;
  }

  if (!eventType || this.options.optOut) {
    if (callback) {
      callback(0, 'No request sent');
    }
    return;
  }
  try {
    var eventId;
    if (eventType === IDENTIFY_EVENT) {
      eventId = this.nextIdentifyId();
      localStorage.setItem(LocalStorageKeys.LAST_IDENTIFY_ID, eventId);
    } else {
      eventId = this.nextEventId();
      localStorage.setItem(LocalStorageKeys.LAST_EVENT_ID, eventId);
    }
    var eventTime = new Date().getTime();
    var ua = this._ua;
    if (!this._sessionId || !this._lastEventTime || eventTime - this._lastEventTime > this.options.sessionTimeout) {
      this._sessionId = eventTime;
      localStorage.setItem(LocalStorageKeys.SESSION_ID, this._sessionId);
    }
    this._lastEventTime = eventTime;
    localStorage.setItem(LocalStorageKeys.LAST_EVENT_TIME, this._lastEventTime);

    // Add the utm properties, if any, onto the user properties.
    userProperties = userProperties || {};
    object.merge(userProperties, this._utmProperties);

    // Add referral info onto the user properties
    if (this.options.includeReferrer) {
      object.merge(userProperties, {
        'referrer': this._getReferrer(),
        'referring_domain': this._getReferringDomain()
      });
    }

    apiProperties = apiProperties || {};
    eventProperties = eventProperties || {};
    var event = {
      device_id: this.options.deviceId,
      user_id: this.options.userId || this.options.deviceId,
      timestamp: eventTime,
      event_id: eventId,
      session_id: this._sessionId || -1,
      event_type: eventType,
      version_name: this.options.versionName || null,
      platform: this.options.platform,
      os_name: ua.browser.name || null,
      os_version: ua.browser.major || null,
      device_model: ua.os.name || null,
      language: this.options.language,
      api_properties: apiProperties,
      event_properties: this._truncate(eventProperties),
      user_properties: this._truncate(userProperties),
      uuid: UUID(),
      library: {
        name: 'amplitude-js',
        version: this.__VERSION__
      }
      // country: null
    };

    if (eventType === IDENTIFY_EVENT) {
      this._unsentIdentifys.push(event);
      if (this._unsentIdentifys.length > this.options.savedMaxCount) {
        this._unsentIdentifys.splice(0, this._unsentIdentifys.length - this.options.savedMaxCount);
      }
    } else {
      this._unsentEvents.push(event);

      // Remove old events from the beginning of the array if too many
      // have accumulated. Don't want to kill memory. Default is 1000 events.
      if (this._unsentEvents.length > this.options.savedMaxCount) {
        this._unsentEvents.splice(0, this._unsentEvents.length - this.options.savedMaxCount);
      }
    }

    if (this.options.saveEvents) {
      this.saveEvents();
    }

    if (!this._sendEventsIfReady(callback) && callback) {
      callback(0, 'No request sent');
    }

    return eventId;
  } catch (e) {
    log(e);
  }
};

Amplitude.prototype.logEvent = function(eventType, eventProperties, callback) {
  return this._logEvent(eventType, eventProperties, null, null, callback);
};

// Test that n is a number or a numeric value.
var _isNumber = function(n) {
  return !isNaN(parseFloat(n)) && isFinite(n);
};

Amplitude.prototype.logRevenue = function(price, quantity, product) {
  // Test that the parameters are of the right type.
  if (!_isNumber(price) || quantity !== undefined && !_isNumber(quantity)) {
    // log('Price and quantity arguments to logRevenue must be numbers');
    return;
  }

  return this._logEvent('revenue_amount', {}, {
    productId: product,
    special: 'revenue_amount',
    quantity: quantity || 1,
    price: price
  });
};

/**
 * Remove events in storage with event ids up to and including maxEventId. Does
 * a true filter in case events get out of order or old events are removed.
 */
Amplitude.prototype.removeEvents = function (maxEventId, maxIdentifyId) {
  if (maxEventId) {
    var filteredEvents = [];
    for (var i = 0; i < this._unsentEvents.length; i++) {
      if (this._unsentEvents[i].event_id > maxEventId) {
        filteredEvents.push(this._unsentEvents[i]);
      }
    }
    this._unsentEvents = filteredEvents;
  }

  if (maxIdentifyId) {
    var filteredIdentifys = [];
    for (var j = 0; j < this._unsentIdentifys.length; j++) {
      if (this._unsentIdentifys[j].event_id > maxIdentifyId) {
        filteredIdentifys.push(this._unsentIdentifys[j]);
      }
    }
    this._unsentIdentifys = filteredIdentifys;
  }
};

Amplitude.prototype.sendEvents = function(callback) {
  if (!this._sending && !this.options.optOut && this._unsentCount() > 0) {
    this._sending = true;
    var url = ('https:' === window.location.protocol ? 'https' : 'http') + '://' +
        this.options.apiEndpoint + '/';

    // Determine how many events to send and track the maximum event id sent in this batch.
    var numEvents = Math.min(this._unsentCount(), this.options.uploadBatchSize);

    // coalesce events from both queues
    var eventsToSend = [];
    var eventIndex = 0;
    var identifyIndex = 0;

    while (eventsToSend.length < numEvents) {
      var event;

      // case 1: no identifys - grab from events
      if (identifyIndex >= this._unsentIdentifys.length) {
        event = this._unsentEvents[eventIndex++];

      // case 2: no events - grab from identifys
      } else if (eventIndex >= this._unsentEvents.length) {
        event = this._unsentIdentifys[identifyIndex++];

      // case 3: need to compare timestamps
      } else {
        if (this._unsentIdentifys[identifyIndex].timestamp <= this._unsentEvents[eventIndex].timestamp) {
          event = this._unsentIdentifys[identifyIndex++];
        } else {
          event = this._unsentEvents[eventIndex++];
        }
      }

      eventsToSend.push(event);
    }

    var maxEventId = eventIndex > 0 && this._unsentEvents.length > 0 ?
      this._unsentEvents[eventIndex - 1].event_id : null;
    var maxIdentifyId = identifyIndex > 0 && this._unsentIdentifys.length > 0 ?
      this._unsentIdentifys[identifyIndex - 1].event_id : null;
    var events = JSON.stringify(eventsToSend);

    var uploadTime = new Date().getTime();
    var data = {
      client: this.options.apiKey,
      e: events,
      v: API_VERSION,
      upload_time: uploadTime,
      checksum: md5(API_VERSION + this.options.apiKey + events + uploadTime)
    };

    var scope = this;
    new Request(url, data).send(function(status, response) {
      scope._sending = false;
      try {
        if (status === 200 && response === 'success') {
          //log('sucessful upload');
          scope.removeEvents(maxEventId, maxIdentifyId);

          // Update the event cache after the removal of sent events.
          if (scope.options.saveEvents) {
            scope.saveEvents();
          }

          // Send more events if any queued during previous send.
          if (!scope._sendEventsIfReady(callback) && callback) {
            callback(status, response);
          }

        } else if (status === 413) {
          //log('request too large');
          // Can't even get this one massive event through. Drop it.
          if (scope.options.uploadBatchSize === 1) {
            // if massive event is identify, still need to drop it
            scope.removeEvents(maxEventId, maxIdentifyId);
          }

          // The server complained about the length of the request.
          // Backoff and try again.
          scope.options.uploadBatchSize = Math.ceil(numEvents / 2);
          scope.sendEvents(callback);

        } else if (callback) { // If server turns something like a 400
          callback(status, response);
        }
      } catch (e) {
        //log('failed upload');
      }
    });
  } else if (callback) {
    callback(0, 'No request sent');
  }
};

/**
 *  @deprecated
 */
Amplitude.prototype.setGlobalUserProperties = Amplitude.prototype.setUserProperties;

Amplitude.prototype.__VERSION__ = version;

module.exports = Amplitude;
