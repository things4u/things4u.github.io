/************* LamPI Node Module **************************************************

Author: M. Westenberg (mw12554@hotmail.com)

1.0; February 10, 2016; Thingspeak first version

***********************************************************************************	*/
// Configuration
var debug = 1;						// 0 is nothing, 1 is normal >= 2 is serious debugging
var init = 0;						// Set to 1 if the init process is running. Stop daemons and ignore incoming messages.

var webPort  = 8081;				// The generic http webserver port for Thingspeak

// Variables
var config={};						// This is the overall LamPI configuration array root
var par   = require('./config/params');

// -------------------------------------------------------------------------------
// These are the libraries that are loaded
//
var fs    = require("fs"); console.log("fs loaded");
var strip = require("strip-json-comments"); console.log("strip-json-comments loaded");
//var async = require("async"); console.log("ssync loaded");
var http  = require('http'); console.log("http loaded");
var express= require('express'); console.log ("express loaded");		// Middleware
var S     = require("string"); console.log("string loaded");
var exec  = require('child_process').exec; console.log("child_process loaded");
var mqtt    = require('mqtt');
var crypto  = require('crypto');

// Own Local modules
var LoRaParse = require('./modules/LoRa'); console.log("LoRa loaded");					// Encryption library. 

console.log("All required modules loaded");

// --------------------------------------------------------------------------------
// Logging function
// --------------------------------------------------------------------------------
function logger(txt,lvl) {
	lvl = lvl || debug;
	if (debug >= lvl) {
		var d = new Date();
		var dd =  ("00" + (d.getMonth() + 1)).slice(-2) + "/" + 
			("00" + d.getDate()).slice(-2) + "/" + 
			d.getFullYear() + " " + 
			("00" + d.getHours()).slice(-2) + ":" + 
			("00" + d.getMinutes()).slice(-2) + ":" + 
			("00" + d.getSeconds()).slice(-2);
		console.log("["+dd+"] "+txt);
	}
}

// Supportive functions
Array.prototype.contains = function(element){
    return this.indexOf(element) > -1;
};

// --------------------------------------------------------------------------------
// COMMAND LINE ARGUMENTS
// --------------------------------------------------------------------------------
process.argv.forEach(function (val, index, array) {
  
  if (index < 2) logger("process.argv["+index+"] skipping: "+val);		// Skip node command and the LamPI-node.js script
  else switch (val) {
	case "-i":
		init = 1;							// We are doing an init operation
		logger("Calling init",1);
		config = readConfig();
		//console.log("config: ",config);
	break;
	case "-r":
		// Only re-read the database into the config structure
		var str = "";
		init = 1;
	break;
	default:
		logger("Process argv:: Unknown commandline argument "+val,1);
	break;
  }
  init = 0;
});


// --------------------------------------------------------------------------------
// EXPRESS middleware
// With help of express we can make routes to separate sections too (and make a REST interface)
// --------------------------------------------------------------------------------
//
var app = express();

//  ROUTE to config
app.all('/config', function (req, res, next) {
  console.log('Printing configuration ...');
  res.send(printConfig());
  //next(); // pass control to the next handler
});
			

// --------------------------------------------------------------------------------
// Initiate Filesystem and define related functions
// Read the standard database configuration file and return the config array object
//
function readConfig() {
	var dbCfg = par.homeDir + "/config/" + "thingspeak.cfg";		// thingspeak.cfg
	var ff = fs.readFileSync(dbCfg, 'utf8');
	logger("readConfig:: par.homeDir: "+par.homeDir+", configFile: "+par.configFile,1);
	try { 												// Assuming we are sent a Json data message of a sensor!
  		var obj = JSON.parse(strip(ff));
	}					
	catch(e){
    	logger("readConfig:: ERROR "+e+", decoding json for config: "+par.ConfigFile,1);
		return;
	}// catch
	if (debug>=1) { logger("readConfig:: config read: ",3); console.log(obj); }
	return(obj);
}

// --------------------------------------------------------------------------------------------
// Talk to thingspeak server with sensor=value
//
// API description at: http://community.thingspeak.com/documentation/api/
// example: https://api.thingspeak.com?key='xxxxxxxxxxxxxxxx'&field1='value'
//
function thingspeak (device,sensor,value, cb) {
	// Find out the right key
	var wkey="";
	var field="";
	for (var i=0; i<config.sensors.length; i++) {
		if (config.sensors[i].device == device) {
			wkey = config.sensors[i].wkey ;
			field = config.sensors[i].sensor[sensor] ;
			break;
		}
	}
	if (wkey == "") { logger("thingspeak:: devicen ot found: "+device,1); return("err",null); }
	
	logger("thinspeak:: key: "+wkey+", field: "+field+", value: "+value,1);
	
	// Then start making the URL
	var ts_init_options = {
		host: 'api.thingspeak.com',
		path: '/update?key='+wkey+'&'+field+'='+value,		// To get ALL thingspeak data, the URL must end with 0
		port: '80',
		method: 'GET',
		headers: { 'Content-Type': 'application/json' }
	};
	
	// Get ALL data from the Zwave controller and put in zroot!
	var ts_init_cb = function(response) {
		var statusCode = response.statusCode;
		if (statusCode === 404 || statusCode === 403) {
            // Send default image if error
			logger("ts_init_cb:: ERROR: Page not found\n",0);
			cb("No Page", null);
        }
		var str = '';
		//another chunk of data has been recieved, so append it to `str`
  		response.on('data', function (chunk) {
    		str += chunk;
		});
		response.on('end', function () {
    		if (debug>=3) console.log(str);
			// Gebruik try here so we catch errors in JSON
			try {
				zroot = JSON.parse(str);
			} catch(e){
				logger("thingspeak:: JSON parse error: "+e,1);
				zroot=null;
			}
			if (zroot != null) devices = zroot.devices;
			//logger("Successfully read thingspeak Data, #devices: "+Object.keys(devices).length,1);
			logger("Successfully read thingspeak Data",1);
			cb(null,"thingspeak done");
  		});
	}
	
	var req = http.request(ts_init_options, ts_init_cb);
	
	req.on('error', function(e) {
		logger("thingspeak:: ERROR opening connection to host, "+e.message,1);
		cb("thinsgpeak no connection",null);
	})
	req.end();
}



// ----------------------------------------------------------------------------
// LoRa MQTT Server
// LoRa messages are Json messages consisting of gatewayEui, nodeEui, time, frequency, dataRate
// resi, snr, rawData, data. The topic is of form "node/020204xx/packages"
// data is the data which is decoded with standard thethingsnetwork key.
// data ini turn contains Json record with sensor data.
// So we work this data into stanrd sensor message of LamPI. topic address is addr.
//
logger("LoRa starting for " + par.loraHost,1);
var LoRa  = mqtt.connect(par.loraHost);

LoRa.on('connect', function () {
  LoRa.subscribe([
	'nodes/02020401/packets',
	'nodes/02020402/packets',
	'nodes/02020403/packets'
  ]);
  logger("LoRa connected to "+par.loraHost,0);
});
// If we receive a MQTT message we will parse the LoRa message. The standard data field contains
// the parsed data but only if teh application key is the same as the TTN network key.
// Therefore we built our own decrypting function which is in the LoRa module.
// This function works on the rawData received by the MQTT server.
LoRa.on('message', function (topic, message) {						// If we receive an MQTT message
  logger('LoRa message:'+message.toString()+", topic: "+topic.toString(),2);
  if (init==1) return;												// If init is active, return without handling...

  var msgJson = JSON.parse(message.toString());						// Decode the MQTT server message into Json structure 
  var splits = topic.split("/");
  var device = splits[1];											// Split the topic part so we have the device address part
  var index = addrSensor(device,0);
  if (index <0) { 
	logger("LoRa:: ERROR unknown index for thing: "+device,0);
	// Standard TTN password. Use application key = TTN network key
	var password = new Buffer([0x2B,0x7E,0x15,0x16,0x28,0xAE,0xD2,0xA6,0xAB,0xF7,0x15,0x88,0x09,0xCF,0x4F,0x3C]);
  } else {
	logger("LoRa:: Thing found in database: index: "+index+" name: "+config['sensors'][index]['name'], 1);
	var pass = config['sensors'][index]['pass'];					// Password String is optional for Sensors
	if ((pass != undefined) && (pass!="")) {						// If there is a special password, Use it
		var password = new Buffer(pass, 'hex');						// Use Password in database
		logger("LoRa:: password: "+password.toString('hex'), 1);
	}
	else {
		// Standard TTN password. Use application key = TTN network key
		var password = new Buffer([0x2B,0x7E,0x15,0x16,0x28,0xAE,0xD2,0xA6,0xAB,0xF7,0x15,0x88,0x09,0xCF,0x4F,0x3C]);
	}
  }
  dataJson = LoRaParse.lParse(topic, message,password);				// LoRa module function to parse/decrypt lora messages
  try { 															// Assuming we are sent a Json data message of a sensor!
  	data = JSON.parse(dataJson); 
  }					
  catch(e){
    logger("LoRa:: ERROR decoding json: "+e+" for message: "+dataJson,1);
	return;
  }// catch
  if (data == null) return;											// So we will stop parsing
 
  logger("LoRa Thingspeak:: Message received",1);
  if (data.t != undefined) thingspeak (device, 'temperature', data.t, function(err, res) { logger("temperature",1) }); 
  if (data.h != undefined) thingspeak (device, 'humidity', data.t, function(err, res) { logger("humidity",1) });	//
  
  if (data.b != undefined) logger("LoRa thingspeak: battery data received: "+data.b, 1);		//
  if (data.a != undefined) logger("LoRa thingspeak: airpressure received: "+data.a, 1);			// 
  if (data.la != undefined) {
	  // GPS data found!
  	  logger("LoRa.on message:: gps found: la "+data.la+", lo "+data.lo, 1);
	  thingspeak (device, 'lat', data.la, function(err, res) { logger("lat",1) });
	  thingspeak (device, 'long', data.lo, function(err, res) { logger("long",1) });
  }
  logger("LoRa.on message:: sensor: "+device+", dataJson  : "+dataJson, 1);
}); // on Message


LoRa.on("error", function (err) {
  console.log("LoRa MQTT error:\n" + err.stack);
  mserver.close();
});
LoRa.on('connect', function(connack) { console.log('LoRa connack: ',connack); });
LoRa.on('reconnect', function() { logger('LoRa reconnected',1); });
LoRa.on('close', function() { logger('LoRa closed',1); });
LoRa.on('offline', function() { logger('LoRa offline',1); });

// ----------------------------------------------------------------------------------------
// Function PRINT CONFIG is called by the /config url route
//
// ----------------------------------------------------------------------------------------
function printConfig() {
	var str="<!DOCTYPE html>";
	Object.keys(config).forEach(function(key) {	
		str += '<h1>'+key+'</h1>';
		logger("printConfig: "+key+", length: "+config[key].length,2);
		str += '<table style="max_width: 100%; border: 1px solid black; border-collapse: collapse;" class="config_table">';
		str += '<tr class="config_line">';
		switch(key) {
			case "sensors":
				Object.keys(config[key][0]).forEach(function(item) {
					str	+= '<th style="background-color: green; color: white;">'+item+'</th>'
				});
			break;
		}
		str += '</tr>'
		for (j=0; j<config[key].length; j++) {
			str += '<tr>';
			switch (key) {
				case "sensors":
					var lupdate;
					Object.keys(config[key][j]).forEach(function(item) {
						switch(item) {
						case 'lastUpdate': // Devices, Sensors
							str += '<td style="border: 1px solid black;">&nbsp'+printTime(config[key][j][item])+'</td>';
						break;
						case 'sensor': // Part of Sensors, for each sensor with index and name sens
							str += '<td style="border: 1px solid black;"><table>';
							Object.keys(config[key][j]['sensor']).forEach(function(sens) {
								str += '<tr>';
								str += '<td>'+printTime(config[key][j]['sensor'][sens]['lastUpdate'])+'</td>';
								str += '<td>'+ sens +": "+parseFloat(config[key][j]['sensor'][sens]['val']).toFixed(1)+ '</td>';
							});
							
							str += '</table></td>';
							str += '<td style="border: 1px solid black;"></td>';
						break;

						default: 
							str += '<td style="border: 1px solid black;">&nbsp'+config[key][j][item]+'</td>';
						}
					})
				break;
			}
			str += '</tr>'			
		}//for
		str += '<br></table>';				// Between sub objects
	});
	
	// Now print the program parameters as well
	str += '<H1>Parameters</H1>';
	str +='<table>';
	Object.keys(par).forEach(function(key) {	
		str += "<tr>"
		str += "<td>"+ key +"</td>";
		str += "<td>: "+ par[key] +"</td>";
		str += "</tr>";									 
	});
	str += "<br></table>";				// Between sub objects	
	return(str);
}



// --------------------------------------------------------------------------------
//	TIME Functions, get the time in string format or as ticks
// --------------------------------------------------------------------------------
//

function printTime(t) {
	var date = new Date(t*1000);
	return ("00"+(date.getMonth()+1)).slice(-2) +"/"+ ("00"+date.getDate()).slice(-2) +"/"+ date.getFullYear()+ " " + S(date.getHours()).padLeft(2,'0').s+ ':' +S(date.getMinutes()).padLeft(2,'0').s+ ':' +S(date.getSeconds()).padLeft(2,'0').s ;
}
  
// --------------------------------------------------------------------------------
// SENSOR helper functions
// --------------------------------------------------------------------------------
function addrSensor(device, channel) {
	logger("addrSensor:: device: "+device+", channel: "+channel,2);
	if (config['sensors'] == undefined) return -1;
	var i;
	for (i=0; i < config.sensors.length; i++) {
		if ((config['sensors'][i]['device'] == device ) && (config['sensors'][i]['channel'] == channel )) {
			break;
		}
	}
	if (i < config['sensors'].length) return(i);
	return(-1);
}

// ================================================================================
//                                MAIN part
// ================================================================================
logger("MAIN part started",1);
logger("config:",1);

for (var i=0; i<config.sensors.length; i++) {
	logger("sensor: "+i+", device: "+config.sensors[i].device,1);
}

