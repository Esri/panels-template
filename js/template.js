define([
  "dojo/Evented",
  "dojo/parser",
  "dojo/_base/declare",
  "dojo/_base/kernel",
  "dojo/_base/array",
  "dojo/_base/lang",
  "dojo/dom-class",
  "dojo/Deferred",
  "dojo/promise/all",
  "esri/arcgis/utils",
  "esri/urlUtils",
  "esri/request",
  "esri/config",
  "esri/IdentityManager",
  "esri/tasks/GeometryService",
  "config/defaults",
  "templateConfig/commonConfig",
  "application/OAuthHelper"
], function (Evented, parser, declare, kernel, array, lang, domClass, Deferred, all, arcgisUtils, urlUtils, esriRequest, esriConfig, IdentityManager, GeometryService, defaults, commonConfig, OAuthHelper) {

  return declare([Evented], {
    config: {},
    localize: false,
    constructor: function (supportsLocalization) {
      //config will contain application and user defined info for the application such as i18n strings,
      //the web map id and application id, any url parameters and any application specific configuration
      // information.
      this.config = declare.safeMixin(defaults, commonConfig);

      this.localize = supportsLocalization || false;
      this._init().then(lang.hitch(this, function () {
        this.emit("ready", this.config);
      }));
    },
    //Get URL parameters and set application defaults needed to query arcgis.com for
    //an application and to see if the app is running in Portal or an Org
    _init: function () {
      var deferred = new Deferred();
      //Set the web map, group and appid if they exist but ignore other url params.
      //Additional url parameters may be defined by the application but they need to be mixed in
      //to the config object after we retrieve the application configuration info. As an example,
      //we'll mix in some commonly used url parameters in the _queryUrlParams function after
      //the application configuration has been applied so that the url parameters overwrite any
      //configured settings. It's up to the application developer to update the application to take
      //advantage of these parameters.
      var paramItems = ['webmap', 'appid', 'oauthappid'];
      var mixinParams = this._createUrlParamsObject(paramItems);
      declare.safeMixin(this.config, mixinParams);
      //Define the sharing url and other default values like the proxy. 
      //The sharing url defines where to search for the web map and application content. The
      //default value is arcgis.com. 
      this._initializeApplication().then(lang.hitch(this, function(){


          all([this._getLocalization(), this._queryOrganizationInformation()]).then(lang.hitch(this, function() {
              this._queryApplicationConfiguration().then(lang.hitch(this, function() {
                  //update URL Parameters. Uncomment the following line and 
                  //edit the _queryUrlParams function if your application needs to support
                  //custom url parameters. 
                  this._queryUrlParams();
                  //setup OAuth if oauth appid exists
                  if (this.config.oauthappid) {
                      this._setupOAuth(this.config.oauthappid, this.config.sharinghost);
                  }
                  deferred.resolve();
              }));
          }));



      }));

      return deferred.promise;
    },
    _createUrlParamsObject: function (items) {
      //retrieve url parameters. Templates all use url parameters to determine which arcgis.com
      //resource to work with.
      //Map templates use the webmap param to define the webmap to display
      //Group templates use the group param to provide the id of the group to display.
      //appid is the id of the application based on the template. We use this
      //id to retrieve application specific configuration information. The configuration
      //information will contain the values the  user selected on the template configuration
      //panel.
      var urlObject = urlUtils.urlToObject(document.location.href);
      urlObject.query = urlObject.query || {};
      var obj = {};
      if (urlObject.query && items && items.length) {
        for (var i = 0; i < items.length; i++) {
          if (urlObject.query[items[i]]) {
            obj[items[i]] = urlObject.query[items[i]];
          }
        }
      }
      return obj;
    },
    _initializeApplication: function() {
        var deferred = new Deferred();

        //Check to see if the app is hosted or a portal. If the app is hosted or a portal set the
        // sharing url and the proxy. Otherwise use the sharing url set it to arcgis.com. 
        //We know app is hosted (or portal) if it has /apps/ or /home/ in the url. 
        var appLocation = location.pathname.indexOf("/apps/");
        if (appLocation === -1) {
            appLocation = location.pathname.indexOf("/home/");
        }
        //app is hosted and no sharing url is defined so let's figure it out. 
        if (appLocation !== -1) {
            //hosted or portal
            var instance = location.pathname.substr(0, appLocation); //get the portal instance name
            this.config.sharinghost = location.protocol + "//" + location.host + instance;
            this.config.proxyurl = location.protocol + "//" + location.host + instance + "/sharing/proxy";
        } else {
            //setup OAuth if oauth appid exists. If we don't call it here before querying for appid
            //the idenity manager dialog will appear if the appid isn't publicly shared. 
            if (this.config.oauthappid) {
                this._setupOAuth(this.config.oauthappid, this.config.sharinghost);
            }
        }
        arcgisUtils.arcgisUrl = this.config.sharinghost + "/sharing/rest/content/items";
        //Define the proxy url for the app 
        if (this.config.proxyurl) {
            esriConfig.defaults.io.proxyUrl = this.config.proxyurl;
            esriConfig.defaults.io.alwaysUseProxy = false;
        }

        //check sign-in status 
        esri.id.checkSignInStatus(this.config.sharinghost + "/sharing").then(
            function(credential){deferred.resolve();},
            function(error){deferred.resolve();}
        );
        return deferred.promise;

    },
    _setupOAuth: function (id, portal) {
      OAuthHelper.init({
        appId: id,
        portal: portal,
        expiration: (14 * 24 * 60) //2 weeks (in minutes)
      });
    },
    _getLocalization: function () {
      var deferred = new Deferred();
      if (this.localize) {
        require(["dojo/i18n!application/nls/resources"], lang.hitch(this, function (appBundle) {
          //Get the localization strings for the template and store in an i18n variable. Also determine if the
          //application is in a right-to-left language like Arabic or Hebrew.
          this.config.i18n = appBundle || {};
          //Bi-directional language support added to support right-to-left languages like Arabic and Hebrew
          //Note: The map must stay ltr
          this.config.i18n.direction = "ltr";
          array.some(["ar", "he"], lang.hitch(this, function (l) {
            if (kernel.locale.indexOf(l) !== -1) {
              this.config.i18n.direction = "rtl";
              return true;
            } else {
              return false;
            }
          }));
          //add a dir attribute to the html tag. Then you can add special css classes for rtl languages
          var dirNode = document.getElementsByTagName("html")[0];
          var classes = dirNode.className;
          if (this.config.i18n.direction === "rtl") {
            //need to add support for dj_rtl.
            //if the dir node is set when the app loads dojo will handle.
            dirNode.setAttribute("dir", "rtl");
            var rtlClasses = " esriRTL dj_rtl dijitRtl " + classes.replace(/ /g, "-rtl ");
            dirNode.className = lang.trim(classes + rtlClasses);
          } else {
            dirNode.setAttribute("dir", "ltr");
            domClass.add(dirNode, "esriLTR");
          }
          deferred.resolve(this.config.i18n);
        }));
      } else {
        deferred.resolve();
      }
      return deferred.promise;
    },
    _queryApplicationConfiguration: function () {
      //If there is an application id query arcgis.com using esri.arcgis.utils.getItem to get the item info.
      // If the item info includes itemData.values then the app was configurable so overwrite the
      // default values with the configured values.
      var deferred = new Deferred();
      if (this.config.appid) {
        arcgisUtils.getItem(this.config.appid).then(lang.hitch(this, function (response) {
          declare.safeMixin(this.config, response.itemData.values);
          //setup OAuth if oauth appid exists. In this situation the oauthappid is specified in the
          //configuration panel.
          if (response.itemData.values && response.itemData.oauthappid) {
            this._setupOAuth(response.itemData.oauthappid, this.config.sharinghost);
          }
          deferred.resolve();
        }));
      } else {
        deferred.resolve();
      }
      return deferred.promise;
    },
    _queryOrganizationInformation: function () {
      var deferred = new Deferred();
      //Get default helper services or if app hosted by portal or org get the specific settings for that organization.
      esriRequest({
          url: this.config.sharinghost + "/sharing/rest/portals/self",
          content: {
              "f": "json"
          },
          callbackParamName: "callback"
      }).then(lang.hitch(this, function(response) {
       
          if(response.untis){
              this.config.units = response.units;
          }else{
              this.config.units = "english";
          }
          this.config.helperServices = {};
          lang.mixin(this.config.helperServices, response.helperServices);
          //Let's set the geometry helper service to be the app default.  
          if (this.config.helperServices && this.config.helperServices.geometry && this.config.helperServices.geometry.url) {
              esriConfig.defaults.geometryService = new GeometryService(this.config.helperServices.geometry.url);
          }
          deferred.resolve();
      }), function(error) {
          console.log(error);
          deferred.resolve();
      });
      return deferred.promise;
    },
    _queryUrlParams: function () {
      var paramItems = ['theme'];
      var mixinParams = this._createUrlParamsObject(paramItems);
      declare.safeMixin(this.config, mixinParams);
    }
  });
});
