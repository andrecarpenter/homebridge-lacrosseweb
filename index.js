/*
 * vi:set sw=4 noet:
 *
 * MIT License
 *
 * Original work Copyright (c) 2018 Phillip Moon
 * Modified work Copyright 2019 Jay Schuster
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

var Service, Characteristic;
const request = require("request-promise-native");
const jar = request.jar();
const rp = request.defaults({"jar": jar});

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerPlatform("homebridge-lacrosseweb", "LacrosseWeb", LacrosseWeb);
};

/*
 * Platform code
 */
function LacrosseWeb(log, config) {
    this.log = log;
    this.config = config;
    this.log("LacrosseWeb(log, config) called.");
    this.parseJSON = s => {
	try {
	    return JSON.parse(s);
	} catch (error) { }
	return false;
    };
}

LacrosseWeb.prototype = {
    accessories: function (callback) {
	this.log("LacrosseWeb.accessories(callback) called.");
	const config = this.config;
	this.apiBaseURL = config["apiBaseURL"] || "http://lacrossealertsmobile.com/v1.2";
	this.apiBaseURL = this.apiBaseURL.lastIndexOf("/") == this.apiBaseURL.length - 1 ? this.apiBaseURL : this.apiBaseURL + "/";
	this.username = config["username"];
	this.password = config["password"];
	this.configCacheSeconds = config["configCacheSeconds"] || 30;
	this.accessories = [];
	this.deviceDictionary = {};
	this.lastLogin = null;
	this.loggedIn = false;
	this.refreshConfigCallbackQueue = [];
	this.callbackRefreshConfigQueue = () => {
	    var item = this.refreshConfigCallbackQueue.pop();
	    this.log("callbackRefreshConfigQueue: started.");
	    while (item) {
		if (typeof item === "function") {
		    item();
		}
		item = this.refreshConfigCallbackQueue.pop();
	    }
	    this.log("callbackRefreshConfigQueue: finished.");
	};
	this.setupAccessories = function (accessories) {
	    this.log("Setting up accessories/devices...");
	    callback(accessories);
	};
	this.instantiateAccessories();
    },

    doLogin: async function () {
	this.log("LacrosseWeb.doLogin() called.");
	// Get the account information page, and grab some values from it.
	var body = await rp.get(this.apiBaseURL + "resources/js/dd/account-enhanced.js?ver=11");
	this.log("GET /login OK");
	const prodKey = body.match(/var\s+prodKey\s*=\s*"([^"]+)"/m)[1];
	const serviceURL = body.match(/var\s+serviceURL\s*=[^"]*"([^"]+)"/m)[1];
	const matches = body.match(/setCookie\(\s*"([^"]+)"\s*,\s*response\.sessionKey\s*,\s*(\d+)/m);
	const cookieName = matches[1];
	const cookieExpYears = matches[2];
	// Authenticate, which returns the session key.
	const subURL = 'https:' + serviceURL + 'user-api.php?pkey=' + prodKey + '&action=userlogin';
	body = await rp.post({
		"url": subURL,
		"form": {
		    "iLogEmail": this.username,
		    "iLogPass": this.password
		}
	}).catch((err) => {
	    this.log("POST /login", err.statusCode);
	    return 302 == err.statusCode ? err.response.body : null;
	});
	if (!body) {
	    this.log("Login failed. Giving up.");
	    this.loggedIn = false;
	    return false;
	}
	this.lastLogin = new Date().getTime();
	body = this.parseJSON(body);
	if (!body || !body.sessionKey) {
	    this.log("Didn't get a session key. Giving up.");
	    this.log(body);
	    this.loggedIn = false;
	    return false;
	}
	// Set the cookie based on the session key.
	//
	// Note: The session key never changes. Once you
	// know it, you don't ever need to retrieve it again.
	const domain = this.apiBaseURL.match(/:\/\/([^\/]*)\//)[1];
	const cookie = cookieName + '=' + body.sessionKey + '; Max-Age=' + (cookieExpYears*365*24*60*60) + '; Domain=' + domain + '; Path=/';
	jar.setCookie(rp.cookie(cookie), this.apiBaseURL);
	// Done
	this.loggedIn = true;
	return true;
    },

    getStatus: async function () {
	this.log("LacrosseWeb.getStatus() called.");
	var body = await rp.get(this.apiBaseURL)
	    .catch((err) => {
		this.log("GET /", err.statusCode);
		this.log(err);
		return null;
	    });
	if (!body) {
	    this.loggedIn = false;
	    return null;  // Error. Not sure what to do. Try logging in again.
	}
	else if (!body.match(/^userProviderID = /m)) {
	    this.log("getStatus(): Didn't get state information");
	    this.log(body);
	    this.loggedIn = false;
	    return null;  // Didn't get state information; try logging in again.
	}
	this.log("GET / OK");
	return body;
    },

    getConfig: async function () {
	this.log("LacrosseWeb.getConfig() called.");
	var body;
	while (!body) {
	    if (!this.loggedIn && !await this.doLogin()) {
		return null;
	    }
	    body = await this.getStatus();
	}
	// We're logged in and have retrieved the status page. Parse it.
	const matches = body.match(/^userProviderID\s=\s(\d+);userGatewaysList\s=\s'(\d+)';var\sisMetric\s=\s(\d);var\sdevicesInitData\s=\s(.*}});var\srefreshInt/m);
	if (!matches) {
	    this.log("getConfig: matching FAILED");
	    this.log(body);
	    return null;
	}
	const userProviderID = parseInt(matches[1], 10);
	const userGatewaysList = matches[2];
	const isMetric = parseInt(matches[3], 10);
	const devicesInitData = this.parseJSON(matches[4]);
	if (!devicesInitData) {
	    this.log("getConfig JSON parsing FAILED:", matches[4]);
	    return null;
	}
	// Parse devicesInitData into devices.
	var devices = [ ];
	for (const key in devicesInitData) {
	    const dev = devicesInitData[key];
	    const obs = dev.obs[0];
	    devices.push({
		"device_id": dev.device_id,
		"name": dev.device_name,
		"services": {
		    "currentTemp": {
			"service_name": "currentTemp",
			"rawvalue": obs.ambient_temp,
			"value": isMetric
				? obs.ambient_temp
				: (obs.ambient_temp - 32) * 5/9
		    },
		    "currentRH": {
			"service_name": "currentRH",
			"value": obs.humidity,
		    },
		    "lowBatt": {
			"service_name": "lowBatt",
			"value": obs.lowbattery
		    }
		}
	    });
	}
	if (0 == devices.length) {
	    this.log("getConfig FAILED");
	    this.log(body);
	    return null;
	}
	this.lastConfigFetch = new Date().getTime();
	this.log("getConfig:");
	this.log(JSON.stringify(devices, null, 2));
	return devices;
    },

    instantiateAccessories: async function () {
	var devices = await this.getConfig();
	if (!devices || devices.length == 0) {
	    this.log("Malformed config, skipping.");
	    return;
	}
	for (let i = 0, l = devices.length; i < l; i++) {
	    let device = devices[i];
	    let name = device.name;
	    if (!name) {
		this.log("Device had no name, not added:");
		this.log(JSON.stringify(device));
		continue;
	    }
	    else if (this.deviceDictionary[name]) {
		this.log(`"${name}" already instantiated.`);
	    }
	    else {
		this.deviceDictionary[name] = new LacrosseWebDevice(this.log, device, this);
		this.accessories.push(this.deviceDictionary[name]);
		this.log(`Added "${name}" - Device ID: ${device.device_id}.`);
	    }
	}
	this.setupAccessories(this.accessories);
    },

    refreshConfig: async function (msg, callback) {
	this.log("Refreshing config for", msg);
	callback = callback || function () {};
	if (this.lastConfigFetch && (new Date().getTime() - this.lastConfigFetch) / 1000 <= this.configCacheSeconds) {
	    this.log(`Using cached data; less than ${this.configCacheSeconds}s old.`);
	    callback();
	    return;
	}
	this.refreshConfigCallbackQueue.push(callback);
	if (this.refreshConfigInProgress) {
	    this.log("Config refresh in progress, queueing callback.");
	    return;
	}
	this.refreshConfigInProgress = true;
	var devices = await this.getConfig();
	if (!devices) {
	    this.log("Config refresh FAILED.");
	    return;
	}
	this.log("Config refresh successful.");
	for (var i = 0, l = devices.length; i < l; i++) {
	    var device = devices[i];
	    var name = device.name;
	    if (!name || !this.deviceDictionary[name]) {
		continue;
	    }
	    this.deviceDictionary[name].updateData(device);
	}
	this.refreshConfigInProgress = false;
	this.callbackRefreshConfigQueue();
    }
}

/*
 * Accessory code
 */
function LacrosseWebDevice(log, details, platform) {
    this.dataMap = {
	"lowBatt": {
	    "intesis": function (homekit) {
		let intesis;
		switch (homekit) {
		    case Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW:
			intesis = 1;
			break;
		    case Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL:
		    default:
			intesis = 0;
			break;
		}
		return intesis;
	    },
	    "homekit": [
	      Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
	      Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
	    ]
	}
    }
    this.log = log;
    this.details = details;
    this.platform = platform;
    this.name = details.name;
    this.temperatureSensor = new Service.TemperatureSensor(details.name);
    this.humiditySensor = new Service.HumiditySensor(details.name);
    this.accessoryInfo = new Service.AccessoryInformation();
    this.accessoryInfo
	.setCharacteristic(Characteristic.Manufacturer, "Lacrosse")
	.setCharacteristic(Characteristic.Model, details.name)
	.setCharacteristic(Characteristic.SerialNumber, details.device_id);
    this.services = [this.temperatureSensor, this.humiditySensor, this.accessoryInfo];
    this.setup(this.details);
}

LacrosseWebDevice.prototype = {
    setup: function (details) {
	var services = details.services;
	var deviceID = details.device_id;
	for (var serviceName in services) {
	    this.addService(services[serviceName], deviceID);
	}
    },
    getServices: function () {
	return this.services;
    },
    updateData: function (newDetails) {
	if (!newDetails) {
	    return;
	}
	this.details = newDetails;
    },
    addService: function (service, deviceID) {
	const serviceName = service.service_name;

	switch (serviceName) {
	    case "currentTemp":
		this.temperatureSensor
		    .getCharacteristic(Characteristic.CurrentTemperature)
		    .on("get", callback => {
			this.platform.refreshConfig("currentTemp", () => {
			    callback(null, this.details.services.currentTemp.value);
			});
		    })
		    .updateValue(this.details.services.currentTemp.value);
		break;
	    case "currentRH":
		this.humiditySensor
		    .getCharacteristic(Characteristic.CurrentRelativeHumidity)
		    .on("get", callback => {
			this.platform.refreshConfig("currentRH", () => {
			    callback(null, this.details.services.currentRH.value);
			});
		    })
		    .updateValue(this.details.services.currentRH.value);
		break;
	    case "lowBatt":
		this.temperatureSensor
		    .getCharacteristic(Characteristic.StatusLowBattery)
		    .on("get", callback => {
			this.platform.refreshConfig("lowBatt", () => {
			    callback(null, this.dataMap.lowBatt.homekit[this.details.services.lowBatt.value]);
			});
		    })
		    .updateValue(this.details.services.lowBatt.value);
		this.humiditySensor
		    .getCharacteristic(Characteristic.StatusLowBattery)
		    .on("get", callback => {
			this.platform.refreshConfig("lowBatt", () => {
			    callback(null, this.details.services.lowBatt.value);
			});
		    })
		    .updateValue(this.details.services.lowBatt.value);
		break;
	}
    }
};
