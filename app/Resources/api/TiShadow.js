/*
 * Copyright (c) 2011-2014 YY Digital Pty Ltd. All Rights Reserved.
 * Please see the LICENSE file included with this distribution for details.
 */

var log = require('/api/Log');
var utils = require('/api/Utils');
var Compression = require('ti.compression');
var assert = require('/api/Assert');
var io = require('ti.socketio');
var osname = Ti.Platform.osname;
var platform = osname === 'ipad' || osname === 'iphone' ? 'ios' : osname;
var socket, room;
var logs = [];

if (!Ti.App.Properties.hasProperty('tishadow:uuid')) {
  Ti.App.Properties.setString('tishadow:uuid', Ti.Platform.createUUID());
}

exports.currentApp;
exports.inspector;
exports.connect = function (o) {
  room = o.room;
  var version_property = 'tishadow:' + room + ':version';
  if (socket) {
    exports.disconnect();
  }
  var uri = (o.proto || 'http') + '://' + o.host + ':' + o.port;
  console.log(uri);
  socket = io.connect(uri, {
    transports: ['websocket'],
    'force new connection': true
  });

  socket.on('connect', function () {
    socket.emit('join', {
      name: o.name,
      uuid: Ti.App.Properties.getString('tishadow:uuid'),
      os_osname: Ti.Platform.osname,
      os_version: Ti.Platform.version,
      app_version: Ti.App.Properties.getString('tishadow:version'),
      room: o.room,
      version: Ti.App.Properties.getString(version_property) || undefined
    });

    logs &&
      logs.forEach(function (log) {
        socket.emit('log', log);
      });
    logs = false;

    if (o.callback) {
      o.callback();
    }
  });
  socket.on('error', function (e) {
    console.log('ERROR');
    console.log(e);
    logs = false; // not sure if needed here
    if (o.onerror) {
      o.onerror(e);
    }
  });
  socket.on('connect_failed', function (e) {
    logs = false;
    if (o.onerror) {
      o.onerror(e);
    }
  });

  // REPL messages
  socket.on('message', function (data) {
    if (!isTarget(data)) {
      return;
    }
    require('/api/PlatformRequire').eval(data);
  });

  socket.on('bundle', function (data) {
    if (!isTarget(data)) {
      return;
    }
    if (exports.Appify && exports.Appify !== data.name) {
      log.info(
        'App Bundle ' + data.name + ' is not for this app: ' + exports.Appify
      );
      return;
    }
    if (data.locale) {
      Ti.App.Properties.setString('tishadow::locale', data.locale);
    }
    loadRemoteZip(
      data.name,
      (o.proto || 'http') + '://' + o.host + ':' + o.port + '/bundle',
      data,
      version_property
    );
  });

  socket.on('clear', function (data) {
    if (!isTarget(data)) {
      return;
    }
    exports.clearCache();
  });

  socket.on('close', function (data) {
    if (!isTarget(data)) {
      return;
    }
    exports.closeApp();
  });

  socket.on('screenshot', function (data) {
    if (!isTarget(data)) {
      return;
    }
    Ti.Media.takeScreenshot(function (o) {
      var image = o.media;
      if (data.scale) {
        var height = Ti.Platform.displayCaps.platformHeight * data.scale;
        var width = Ti.Platform.displayCaps.platformWidth * data.scale;
        image = image.imageAsResized(width, height);
      }
      var imgStr = Ti.Utils.base64encode(image).toString();
      socket.emit('screenshot_taken', { image: imgStr });
    });
  });

  socket.on('disconnect', function () {
    if (o.disconnected) {
      o.disconnected();
    }
  });
};

exports.emitLog = function (e) {
  if (socket && !logs) {
    socket.emit('log', e);
  } else {
    logs.push(e);
  }
};

exports.disconnect = function () {
  if (socket) {
    socket.disconnect();
  }
};

var bundle;
function restart() {
  Ti.App.Properties.setBool('tishadow::reconnect', true);
  Ti.App.fireEvent('tishadow:close');
  exports.disconnect();
  if (Ti.Android) {
    Ti.App._restart();
  } else {
    require('/api/UI').closeAll();
    require('/api/App').clearAll();
    Ti.App._restart();
  }
}
exports.closeApp = function () {
  Ti.App.Properties.setString('tishadow::currentApp', '');
  restart();
};
exports.nextApp = function (name) {
  Ti.App.Properties.setString(
    'tishadow::currentApp',
    name ? name.replace(/ /g, '_') : exports.currentApp
  );
  restart();
};
exports.launchApp = function (name) {
  try {
    var p = require('/api/PlatformRequire');
    // Custom Fonts
    if (osname === 'ipad' || osname === 'iphone') {
      require('/api/Fonts').loadCustomFonts(name);
    }
    // still requires cache clean on restart
    p.clearCache();
    require('/api/Localisation').clear();

    Ti.App.Properties.setString('tishadow::currentApp', '');
    Ti.App.Properties.setBool('tishadow::reconnect', false);

    //initialise custom localisation
    var locale = Ti.App.Properties.getString('tishadow::locale', '');
    if (locale) {
      require('/api/Localisation').locale = locale;
    }

    exports.currentApp = name;
    exports.inspector = Ti.App.Properties.getBool('tishadow:inspector', false);

    bundle = p.include(null, '/app.js');
    log.info(exports.currentApp.replace(/_/g, ' ') + ' launched.');
  } catch (e) {
    log.error(utils.extractExceptionData(e));
  }
};

exports.clearCache = function (no_restart) {
  Ti.App.Properties.listProperties().forEach(function (property) {
    if (!property.match('^tishadow:') || property === 'tishadow::locale') {
      Ti.App.Properties.removeProperty(property);
    }
  });

  var dirty_directories = [Ti.Filesystem.applicationDataDirectory];
  if (Ti.UI.iOS) {
    var applicationDatabaseDirectory =
      Ti.Filesystem.applicationDataDirectory.replace('Documents/', '') +
      'Library/Private%20Documents/';
    if (Ti.Filesystem.getFile(applicationDatabaseDirectory).exists()) {
      dirty_directories.push(applicationDatabaseDirectory);
    }
  }

  try {
    dirty_directories.forEach(function (targetDirectory) {
      // Clear Applications
      var files = Ti.Filesystem.getFile(targetDirectory).getDirectoryListing();
      files.forEach(function (file_name) {
        var file = Ti.Filesystem.getFile(targetDirectory, file_name);
        if (Ti.Platform.osname === 'android') {
          if (file.isFile()) {
            file.deleteFile();
          } else if (file.isDirectory()) {
            file.deleteDirectory(true);
          }
        } else {
          file.deleteFile();
          file.deleteDirectory(true);
        }
      });
    });
  } catch (e) {
    log.error(utils.extractExceptionData(e));
  }
  log.info('Cache cleared');
  if (!no_restart) {
    exports.closeApp();
  }
};

function loadRemoteZip(name, url, data, version_property) {
  var xhr = Ti.Network.createHTTPClient();
  xhr.timeout = 10000;
  xhr.onload = function (e) {
    try {
      log.info('Unpacking new bundle: ' + name);

      var path_name = name.replace(/ /g, '_');
      // SAVE ZIP
      var zip_file = Ti.Filesystem.getFile(
        Ti.Filesystem.applicationDataDirectory,
        path_name + '.zip'
      );
      zip_file.write(this.responseData);
      // Prepare path
      var target = Ti.Filesystem.getFile(
        Ti.Filesystem.applicationDataDirectory,
        path_name
      );
      if (!target.exists()) {
        target.createDirectory();
      }
      // Extract
      var dataDir = Ti.Filesystem.applicationDataDirectory + '/';
      Compression.unzip(
        dataDir + path_name,
        dataDir + path_name + '.zip',
        true
      );
      if (data && data.version && version_property) {
        Ti.App.Properties.setString(version_property, data.version);
      } else {
        Ti.App.Properties.removeProperty(version_property);
      }
      exports.inspector = data.inspector;
      Ti.App.Properties.setBool('tishadow:inspector', data.inspector || false);
      // Launch
      if (data && data.spec && data.spec.run) {
        exports.currentApp = path_name;
        require('/api/Spec').run(
          path_name,
          data.spec.junitxml,
          data.spec.type,
          data.spec.clearSpecFiles,
          data.spec.runCoverage
        );
      } else if (data && data.patch && data.patch.run) {
        require('/api/PlatformRequire').clearCache(data.patch.files);
      } else {
        exports.nextApp(path_name);
      }
    } catch (e) {
      log.error(utils.extractExceptionData(e));
    }
  };
  xhr.onerror = function (e) {
    Ti.UI.createAlertDialog({
      title: 'XHR',
      message: 'Error: ' + e.error
    }).show();
  };
  xhr.open(
    'GET',
    url + '/' + room + '/' + Ti.App.Properties.getString('tishadow:uuid')
  );
  xhr.send();
}

function isTarget(data) {
  return (
    !data.platform ||
    data.platform.indexOf(osname) !== -1 ||
    data.platform.indexOf(platform) !== -1
  );
}

// FOR URL SCHEME - tishadow://
function loadRemoteBundle(url) {
  if (url.indexOf('.zip') === -1) {
    alert('Invalid Bundle');
  } else {
    var name_parts = url.split('/');
    var name = name_parts[name_parts.length - 1].replace('.zip', '');
    loadRemoteZip(name, url);
  }
}

function parseArguments() {
  setTimeout(function () {
    cmd = Ti.App.getArguments();
    if (typeof cmd == 'object' && cmd.hasOwnProperty('url')) {
      if (cmd.url !== url) {
        url = cmd.url;
        if (url.substring(0, 8) === 'tishadow') {
          loadRemoteBundle(url.replace('tishadow', 'http'));
        }
      }
    }
  }, 0);
}

var url = '';
if (osname !== 'android') {
  parseArguments();
  Ti.App.addEventListener('resumed', parseArguments);
}
