// Create ambient declarations for global node.js variables.
declare var process: any;
declare var require: <ModuleType>(moduleId: string) => ModuleType;
declare var module: { exports: any; };

export interface Config {
	baseUrl?: string;
	map?: ModuleMap;
	packages?: Package[];
	paths?: { [path: string]: string; };
}

export interface Define {
	(moduleId: string, dependencies: string[], factory: Factory): void;
	(dependencies: string[], factory: Factory): void;
	(factory: Factory): void;
	(value: any): void;
}

export interface Factory {
	(...modules: any[]): any;
}

export interface Has {
	(name: string): any;
	add(name: string, value: (global: Window, document?: HTMLDocument, element?: HTMLDivElement) => any, now?: boolean, force?: boolean): void;
	add(name: string, value: any, now?: boolean, force?: boolean): void;
}

export interface LoaderPlugin {
	dynamic?: boolean;
	load?: (resourceId: string, require: Require, load: (value?: any) => void, config?: Object) => void;
	normalize?: (moduleId: string, normalize: (moduleId: string) => string) => string;
}

export interface MapItem extends Array<any> {
	/* prefix */      0: string;
	/* replacement */ 1: any;
	/* regExp */      2: RegExp;
	/* length */      3: number;
}

export interface MapReplacement extends MapItem {
	/* replacement */ 1: string;
}

export interface MapRoot extends Array<MapSource> {
	star?: MapSource;
}

export interface MapSource extends MapItem {
	/* replacement */ 1: MapReplacement[];
}

export interface Module extends LoaderPlugin {
	cjs: {
		exports: any;
		id: string;
		setExports: (exports: any) => void;
		uri: string;
	};
	def: Factory;
	deps: Module[];
	executed: any; // TODO: enum
	injected: boolean;
	fix?: (module: Module) => void;
	gc: boolean;
	mid: string;
	pack: Package;
	req: Require;
	require?: Require; // TODO: WTF?
	result: any;
	url: string;

	// plugin interface
	loadQ?: Module[];
	plugin?: Module;
	prid: string;
}

export interface ModuleMap extends ModuleMapItem {
	[sourceMid: string]: ModuleMapReplacement;
}

export interface ModuleMapItem {
	[mid: string]: /*ModuleMapReplacement|ModuleMap*/any;
}

export interface ModuleMapReplacement extends ModuleMapItem {
	[findMid: string]: /* replaceMid */string;
}

export interface Package {
	location?: string;
	main?: string;
	name?: string;
}

export interface PackageMap {
	[packageId: string]: Package;
}

export interface PathMap extends MapReplacement {}

export interface Require {
	(config: Config, dependencies?: string[], callback?: RequireCallback): void;
	(dependencies: string[], callback: RequireCallback): void;
	<ModuleType>(moduleId: string): ModuleType;

	toAbsMid(moduleId: string): string;
	toUrl(path: string): string;
}

export interface RequireCallback {
	(...modules: any[]): void;
}

export interface RootRequire extends Require {
	config(config: Config): void;
	has: Has;
	inspect?(name: string): any;
	nodeRequire?(id: string): any;
	undef(moduleId: string): void;
}

(function (): void {

	const EXECUTING: string = 'executing';
	const abortExec: Object = {};

	//
	// loader state data
	//
	// AMD baseUrl config
	let baseUrl: string = './';

	// hash: (mid | url)-->(function | string)
	//
	// A cache of resources. The resources arrive via a require.cache application, which takes a hash from either mid --> function or
	// url --> string. The function associated with mid keys causes the same code to execute as if the module was script injected.
	//
	// Both kinds of key-value pairs are entered into cache via the function consumePendingCache, which may relocate keys as given
	// by any mappings *iff* the cache was received as part of a module resource request.
	let cache: { [moduleId: string]: any; } = {};

	let checkCompleteGuard: number = 0;

	// The arguments sent to loader via AMD define().
	let defArgs: any[] = null;

	// The list of modules that need to be evaluated.
	let execQ: Module[] = [];

	let executedSomething: boolean = false;

	let injectUrl: (url: string, callback: (node?: HTMLScriptElement) => void, module: Module, parent?: Module) => void;

	// AMD map config variable
	let map: ModuleMap = {};

	// array of quads as described by computeMapProg; map-key is AMD map key, map-value is AMD map value
	let mapProgs: MapRoot = [];

	// A hash: (mid) --> (module-object) the module namespace
	//
	// pid: the package identifier to which the module belongs (e.g., "dojo"); "" indicates the system or default package
	// mid: the fully-resolved (i.e., mappings have been applied) module identifier without the package identifier (e.g., "dojo/io/script")
	// url: the URL from which the module was retrieved
	// pack: the package object of the package to which the module belongs
	// executed: false => not executed; EXECUTING => in the process of tranversing deps and running factory; true => factory has been executed
	// deps: the dependency array for this module (array of modules objects)
	// def: the factory for this module
	// result: the result of the running the factory for this module
	// injected: true => module has been injected
	// load, dynamic, normalize: plugin functions applicable only for plugins
	//
	// Modules go through several phases in creation:
	//
	// 1. Requested: some other module's definition or a require application contained the requested module in
	//    its dependency array
	//
	// 2. Injected: a script element has been appended to the insert-point element demanding the resource implied by the URL
	//
	// 3. Loaded: the resource injected in [2] has been evaluated.
	//
	// 4. Defined: the resource contained a define statement that advised the loader about the module.
	//
	// 5. Evaluated: the module was defined via define and the loader has evaluated the factory and computed a result.
	let modules: { [moduleId: string]: Module; } = {};

	// a map from pid to package configuration object
	let packs: PackageMap = {};

	// list of (from-path, to-path, regex, length) derived from paths;
	// a "program" to apply paths; see computeMapProg
	let pathsMapProg: PathMap[] = [];

	// hash: (mid | url)-->(function | string)
	//
	// Gives a set of cache modules pending entry into cache. When cached modules are published to the loader, they are
	// entered into pendingCacheInsert; modules are then pressed into cache upon (1) AMD define or (2) upon receiving another
	// independent set of cached modules. (1) is the usual case, and this case allows normalizing mids given in the pending
	// cache for the local configuration, possibly relocating modules.
	let pendingCacheInsert: { [moduleId: string]: any; } = {};

	let setGlobals: (require: Require, define: Define) => void;

	let uidGenerator: number = 0;

	// the number of modules the loader has injected but has not seen defined
	let waitingCount: number = 0;

	const has: Has = (function (): Has {
		const hasCache: { [name: string]: any; } = Object.create(null);
		const global: Window = this;
		const document: HTMLDocument = global.document;
		const element: HTMLDivElement = document && document.createElement('div');

		const has: Has = <Has> function(name: string): any {
			return typeof hasCache[name] === 'function' ? (hasCache[name] = hasCache[name](global, document, element)) : hasCache[name];
		};

		has.add = function (name: string, test: any, now: boolean, force: boolean): void {
			(!(name in hasCache) || force) && (hasCache[name] = test);
			now && has(name);
		};

		return has;
	})();

	const req: RootRequire = <RootRequire> function (config: any, dependencies?: any, callback?: RequireCallback): Module {
		if (/* require([], cb) */ Array.isArray(config) || /* require(mid) */ typeof config === 'string') {
			callback = <RequireCallback> dependencies;
			dependencies = <string[]> config;
			config = {};
		}

		has('loader-configurable') && configure(config);

		return contextRequire(dependencies, callback);
	};
	req.has = has;

	has.add('host-browser', typeof document !== 'undefined' && typeof location !== 'undefined');
	has.add('host-node', typeof process === 'object' && process.versions && process.versions.node);
	has.add('debug', true);

	// IE9 will process multiple scripts at once before firing their respective onload events, so some extra work
	// needs to be done to associate the content of the define call with the correct node. This is known to be fixed
	// in IE10 and the bad behaviour cannot be inferred through feature detection, so simply target this one user-agent
	has.add('loader-ie9-compat', has('host-browser') && navigator.userAgent.indexOf('MSIE 9.0') > -1);

	has.add('loader-configurable', true);
	if (has('loader-configurable')) {
		/**
		 * Configures the loader.
		 *
		 * @param {{ ?baseUrl: string, ?map: Object, ?packages: Array.<({ name, ?location, ?main }|string)> }} config
		 * The configuration data.
		 */
		var configure: (config: Config) => void = req.config = function (config: Config): void {
			// TODO: Expose all properties on req as getter/setters? Plugin modules like dojo/node being able to
			// retrieve baseUrl is important. baseUrl is defined as a getter currently.
			baseUrl = (config.baseUrl || baseUrl).replace(/\/*$/, '/');

			forEach(config.packages, function (p: Package): void {
				// Allow shorthand package definition, where name and location are the same
				if (typeof p === 'string') {
					p = { name: <string> p, location: <string> p };
				}

				if (p.location != null) {
					p.location = p.location.replace(/\/*$/, '/');
				}

				packs[p.name] = p;
			});

			function computeMapProg(map: ModuleMapItem): MapItem[] {
				// This method takes a map as represented by a JavaScript object and initializes an array of
				// arrays of (map-key, map-value, regex-for-map-key, length-of-map-key), sorted decreasing by length-
				// of-map-key. The regex looks for the map-key followed by either "/" or end-of-string at the beginning
				// of a the search source.
				//
				// Maps look like this:
				//
				// map: { C: { D: E } }
				//      A    B
				//
				// The computed mapping is a 4-array deep tree, where the outermost array corresponds to the source
				// mapping object A, the 2nd level arrays each correspond to one of the source mappings C -> B, the 3rd
				// level arrays correspond to each destination mapping object B, and the innermost arrays each
				// correspond to one of the destination mappings D -> E.
				//
				// So, the overall structure looks like this:
				//
				// mapProgs = [ source mapping array, source mapping array, ... ]
				// source mapping array = [
				//     source module id,
				//     [ destination mapping array, destination mapping array, ... ],
				//     RegExp that matches on source module id,
				//     source module id length
				// ]
				// destination mapping array = [
				//     original module id,
				//     destination module id,
				//     RegExp that matches on original module id,
				//     original module id length
				// ]

				const result: MapItem[] = [];

				for (let moduleId in map) {
					const value: any = (<any> map)[moduleId];
					const valueIsMapReplacement: boolean = typeof value === 'object';

					const item = <MapItem> {
						0: moduleId,
						1: valueIsMapReplacement ? computeMapProg(value) : value,
						2: new RegExp('^' + moduleId.replace(/[-\[\]{}()*+?.,\\\^$|#\s]/g, '\\$&') + '(?:\/|$)'),
						3: moduleId.length
					};
					result.push(item);

					if (valueIsMapReplacement && moduleId === '*') {
						(<MapRoot> result).star = item[1];
					}
				}

				result.sort(function (lhs: any, rhs: any): number {
					return rhs[3] - lhs[3];
				});

				return result;
			}

			mix(map, config.map);

			mapProgs = computeMapProg(map);

			// Note that old paths will get destroyed if reconfigured
			config.paths && (pathsMapProg = computeMapProg(config.paths));
		};
	}

	function forEach<T>(array: T[], callback: (value: T, index: number, array: T[]) => void): void {
		array && array.forEach(callback);
	}

	function mix(target: {}, source: {}): {} {
		for (let key in source) {
			(<any> target)[key] = (<any> source)[key];
		}
		return target;
	}

	function consumePendingCacheInsert(referenceModule?: Module): void {
		let item: any;

		for (let key in pendingCacheInsert) {
			item = pendingCacheInsert[key];

			cache[typeof item === 'string' ? toUrl(key, referenceModule) : getModuleInfo(key, referenceModule).mid] = item;
		}

		pendingCacheInsert = {};
	}

	function contextRequire(moduleId: string, unused?: void, referenceModule?: Module): Module;
	function contextRequire(dependencies: string[], callback: RequireCallback, referenceModule?: Module): Module;
	function contextRequire(a1: any, a2: any, referenceModule?: Module): Module {
		let module: Module;
		if (typeof a1 === 'string') {
			module = getModule(a1, referenceModule);
			if (module.executed !== true && module.executed !== EXECUTING) {
				if (has('host-node')) {
					let result = nodeLoadModule(module.mid, referenceModule);
					if (result) {
						initModule(module, [], null);
						module.result = result;
						module.cjs.setExports(result);
						module.executed = true;
						module.injected = true;
					} else {
						throw new Error('Attempt to require unloaded module ' + module.mid);
					}
				}
			}
			// Assign the result of the module to `module`
			// otherwise require('moduleId') returns the internal
			// module representation
			module = module.result;
		}
		else if (Array.isArray(a1)) {
			// signature is (requestList [,callback])
			// construct a synthetic module to control execution of the requestList, and, optionally, callback
			module = getModuleInfo('*' + (++uidGenerator));
			mix(module, {
				deps: resolveDeps(a1, module, referenceModule),
				def: a2 || {},
				gc: true // garbage collect
			});
			guardCheckComplete(function (): void {
				forEach(module.deps, injectModule.bind(null, module));
			});
			execQ.push(module);
			checkComplete();
		}
		return module;
	}

	function createRequire(module: Module): Require {
		let result: Require = (!module && req) || module.require;
		if (!result) {
			module.require = result = <Require> function (a1: any, a2: any): Module {
				return contextRequire(a1, a2, module);
			};
			mix(mix(result, req), {
				toUrl: function (name: string): string {
					return toUrl(name, module);
				},
				toAbsMid: function (mid: string): string {
					return toAbsMid(mid, module);
				}
			});
		}
		return result;
	}

	function runMapProg(targetMid: string, map: MapItem[]): MapSource {
		// search for targetMid in map; return the map item if found; falsy otherwise
		if (map) {
			for (let i = 0, j = map.length; i < j; ++i) {
				if (map[i][2].test(targetMid)) {
					return map[i];
				}
			}
		}

		return null;
	}

	function compactPath(path: string): string {
		let result: string[] = [];
		let segment: string;
		let lastSegment: string;
		const splitPath: string[] = path.replace(/\\/g, '/').split('/');

		while (splitPath.length) {
			segment = splitPath.shift();
			if (segment === '..' && result.length && lastSegment !== '..') {
				result.pop();
				lastSegment = result[result.length - 1];
			}
			else if (segment !== '.') {
				result.push((lastSegment = segment));
			} // else ignore "."
		}

		return result.join('/');
	}

	function getModuleInfo(mid: string, referenceModule?: Module): Module {
		let match: string[];
		let pid: string;
		let pack: Package;
		let midInPackage: string;
		let mapItem: MapItem;
		let url: string;
		let result: Module;

		// relative module ids are relative to the referenceModule; get rid of any dots
		mid = compactPath(/^\./.test(mid) && referenceModule ? (referenceModule.mid + '/../' + mid) : mid);
		// at this point, mid is an absolute mid

		// if there is a reference module, then use its module map, if one exists; otherwise, use the global map.
		// see computeMapProg for more information on the structure of the map arrays
		let moduleMap: MapItem = referenceModule && runMapProg(referenceModule.mid, mapProgs);
		moduleMap = moduleMap ? moduleMap[1] : mapProgs.star;

		if ((mapItem = runMapProg(mid, moduleMap))) {
			mid = mapItem[1] + mid.slice(mapItem[3]);
		}

		match = mid.match(/^([^\/]+)(\/(.+))?$/);
		pid = match ? match[1] : '';
		pack = packs[pid];

		if (pack) {
			mid = pid + '/' + (midInPackage = (match[3] || pack.main || 'main'));
		}
		else {
			pid = '';
		}

		if (!(result = modules[mid])) {
			mapItem = runMapProg(mid, pathsMapProg);
			url = mapItem ? mapItem[1] + mid.slice(mapItem[3]) : (pid ? pack.location + midInPackage : mid);
			result = <Module> <any> {
				pid: pid,
				mid: mid,
				pack: pack,
				url: compactPath(
					// absolute urls should not be prefixed with baseUrl
					(/^(?:\/|\w+:)/.test(url) ? '' : baseUrl) +
					url +
					// urls with a javascript extension should not have another one added
					(/\.js(?:\?[^?]*)?$/.test(url) ? '' : '.js')
				)
			};
		}

		return result;
	}

	function resolvePluginResourceId(plugin: Module, prid: string, contextRequire: Require): string {
		return plugin.normalize ? plugin.normalize(prid, contextRequire.toAbsMid) : contextRequire.toAbsMid(prid);
	}

	function getModule(mid: string, referenceModule?: Module): Module {
		// compute and construct (if necessary) the module implied by the mid with respect to referenceModule
		let match: string[];
		let plugin: Module;
		let prid: string;
		let result: Module;
		let contextRequire: Require;
		let loaded: boolean;

		match = mid.match(/^(.+?)\!(.*)$/);
		if (match) {
			// name was <plugin-module>!<plugin-resource-id>
			plugin = getModule(match[1], referenceModule);
			loaded = Boolean(plugin.load);

			contextRequire = createRequire(referenceModule);

			if (loaded) {
				prid = resolvePluginResourceId(plugin, match[2], contextRequire);
				mid = (plugin.mid + '!' + (plugin.dynamic ? ++uidGenerator + '!' : '') + prid);
			}
			else {
				// if the plugin has not been loaded, then can't resolve the prid and must assume this plugin is dynamic until we find out otherwise
				prid = match[2];
				mid = plugin.mid + '!' + (++uidGenerator) + '!*';
			}
			result = <Module> <any> {
				plugin: plugin,
				mid: mid,
				req: contextRequire,
				prid: prid,
				fix: !loaded
			};
		}
		else {
			result = getModuleInfo(mid, referenceModule);
		}
		return modules[result.mid] || (modules[result.mid] = result);
	}

	function toAbsMid(mid: string, referenceModule: Module): string {
		return getModuleInfo(mid, referenceModule).mid;
	}

	function toUrl(name: string, referenceModule: Module): string {
		const moduleInfo: Module = getModuleInfo(name + '/x', referenceModule);
		const url: string = moduleInfo.url;

		// "/x.js" since getModuleInfo automatically appends ".js" and we appended "/x" to make name look like a module id
		return url.slice(0, url.length - 5);
	}

	function makeCjs(mid: string): Module {
		return (modules[mid] = <Module> <any> {
			mid: mid,
			injected: true,
			executed: true
		});
	}
	const cjsRequireModule: Module = makeCjs('require');
	const cjsExportsModule: Module = makeCjs('exports');
	const cjsModuleModule: Module = makeCjs('module');

	has.add('loader-debug-circular-dependencies', true);
	if (has('loader-debug-circular-dependencies')) {
		var circularTrace: string[] = [];
	}

	function execModule(module: Module): any {
		// run the dependency array, then run the factory for module
		if (module.executed === EXECUTING) {
			// for circular dependencies, assume the first module encountered was executed OK
			// modules that circularly depend on a module that has not run its factory will get
			// the premade cjs.exports===module.result. They can take a reference to this object and/or
			// add properties to it. When the module finally runs its factory, the factory can
			// read/write/replace this object. Notice that so long as the object isn't replaced, any
			// reference taken earlier while walking the deps list is still valid.
			if (
				has('loader-debug-circular-dependencies') &&
				module.deps.indexOf(cjsExportsModule) === -1 &&
				typeof console !== 'undefined'
			) {
				console.warn('Circular dependency: ' + circularTrace.concat(module.mid).join(' -> '));
			}

			return module.result;
		}

		if (!module.executed) {
			// TODO: This seems like an incorrect condition inference. Originally it was simply !module.def
			// which caused modules with falsy defined values to never execute.
			if (!module.def && !module.deps) {
				return abortExec;
			}

			const deps: Module[] = module.deps;
			const factory: Factory = module.def;
			let result: any;
			let args: any[];

			has('loader-debug-circular-dependencies') && circularTrace.push(module.mid);

			module.executed = EXECUTING;
			args = deps.map(function (dep: Module): any {
				if (result !== abortExec) {
					result = ((dep === cjsRequireModule) ? createRequire(module) :
								((dep === cjsExportsModule) ? module.cjs.exports :
									((dep === cjsModuleModule) ? module.cjs :
										execModule(dep))));
				}
				return result;
			});

			if (result === abortExec) {
				module.executed = false;
				has('loader-debug-circular-dependencies') && circularTrace.pop();
				return abortExec;
			}

			result = typeof factory === 'function' ? factory.apply(null, args) : factory;

			// TODO: But of course, module.cjs always exists.
			// Assign the new module.result to result so plugins can use exports
			// to define their interface; the plugin checks below use result
			result = module.result = result === undefined && module.cjs ? module.cjs.exports : result;
			module.executed = true;
			executedSomething = true;

			// delete references to synthetic modules
			if (module.gc) {
				modules[module.mid] = undefined;
			}

			// if result defines load, just assume it's a plugin; harmless if the assumption is wrong
			result && result.load && [ 'dynamic', 'normalize', 'load' ].forEach(function (key: string): void {
				(<any> module)[key] = (<any> result)[key];
			});

			// for plugins, resolve the loadQ
			forEach(module.loadQ, function (pseudoPluginResource: Module): void {
				// manufacture and insert the real module in modules
				const prid: string = resolvePluginResourceId(module, pseudoPluginResource.prid, pseudoPluginResource.req);
				const mid: string = module.dynamic ? pseudoPluginResource.mid.replace(/\*$/, prid) : (module.mid + '!' + prid);
				const pluginResource: Module = <Module> mix(mix({}, pseudoPluginResource), { mid: mid, prid: prid });

				if (!modules[mid]) {
					// create a new (the real) plugin resource and inject it normally now that the plugin is on board
					injectPlugin((modules[mid] = pluginResource));
				} // else this was a duplicate request for the same (plugin, rid) for a nondynamic plugin

				// pluginResource is really just a placeholder with the wrong mid (because we couldn't calculate it until the plugin was on board)
				// fix() replaces the pseudo module in a resolved deps array with the real module
				// lastly, mark the pseudo module as arrived and delete it from modules
				pseudoPluginResource.fix(modules[mid]);
				--waitingCount;
				modules[pseudoPluginResource.mid] = undefined;
			});
			module.loadQ = undefined;

			has('loader-debug-circular-dependencies') && circularTrace.pop();
		}

		// at this point the module is guaranteed fully executed
		return module.result;
	}

	// TODO: Figure out what proc actually is
	function guardCheckComplete(proc: Function): void {
		++checkCompleteGuard;
		proc();
		--checkCompleteGuard;
	}

	function checkComplete(): void {
		// keep going through the execQ as long as at least one factory is executed
		// plugins, recursion, cached modules all make for many execution path possibilities
		!checkCompleteGuard && guardCheckComplete(function (): void {
			for (let module: Module, i = 0; i < execQ.length; ) {
				module = execQ[i];
				if (module.executed === true) {
					execQ.splice(i, 1);
				}
				else {
					executedSomething = false;
					execModule(module);
					if (executedSomething) {
						// something was executed; this indicates the execQ was modified, maybe a
						// lot (for example a later module causes an earlier module to execute)
						i = 0;
					}
					else {
						// nothing happened; check the next module in the exec queue
						i++;
					}
				}
			}
		});
	}

	function injectPlugin(module: Module): void {
		// injects the plugin module given by module; may have to inject the plugin itself
		const plugin: Module = module.plugin;
		const onLoad = function (def: any): void {
				module.result = def;
				--waitingCount;
				module.executed = true;
				checkComplete();
			};

		if (plugin.load) {
			plugin.load(module.prid, module.req, onLoad);
		}
		else if (plugin.loadQ) {
			plugin.loadQ.push(module);
		}
		else {
			// the unshift instead of push is important: we don't want plugins to execute as
			// dependencies of some other module because this may cause circles when the plugin
			// loadQ is run; also, generally, we want plugins to run early since they may load
			// several other modules and therefore can potentially unblock many modules
			plugin.loadQ = [module];
			execQ.unshift(plugin);
			injectModule(module, plugin);
		}
	}

	function injectModule(parent: Module, module: Module): void {
		// TODO: This is for debugging, we should bracket it
		if (!module) {
			module = parent;
			parent = null;
		}

		if (module.plugin) {
			injectPlugin(module);
		}
		else if (!module.injected) {
			let cached: Factory;
			const onLoadCallback = function (node?: HTMLScriptElement): void {
				// defArgs is an array of [dependencies, factory]
				consumePendingCacheInsert(module);

				if (has('loader-ie9-compat') && node) {
					defArgs = (<any> node).defArgs;
				}

				// non-amd module
				if (!defArgs) {
					defArgs = [ [], undefined ];
				}

				defineModule(module, defArgs[0], defArgs[1]);
				defArgs = null;

				guardCheckComplete(function (): void {
					forEach(module.deps, injectModule.bind(null, module));
				});
				checkComplete();
			};

			++waitingCount;
			module.injected = true;
			if ((cached = cache[module.mid])) {
				try {
					cached();
					onLoadCallback();
					return;
				}
				catch (error) {
					// If a cache load fails, retrieve using injectUrl
					// TODO: report error, 'cachedThrew', [ error, module ]
				}
			}
			injectUrl(module.url, onLoadCallback, module, parent);
		}
	}

	function resolveDeps(deps: string[], module: Module, referenceModule: Module): Module[] {
		// resolve deps with respect to this module
		return deps.map(function (dep: string, i: number): Module {
			const result: Module = getModule(dep, referenceModule);
			if (result.fix) {
				result.fix = function (m: Module): void {
					module.deps[i] = m;
				};
			}
			return result;
		});
	}

	function defineModule(module: Module, deps: string[], def: Factory): Module {
		--waitingCount;
		return initModule(module, deps, def);
	}

	function initModule(module: Module, deps: string[], def: Factory): Module {
		return <Module> mix(module, {
			def: def,
			deps: resolveDeps(deps, module, module),
			cjs: {
				id: module.mid,
				uri: module.url,
				exports: (module.result = {}),
				setExports: function (exports: any): void {
					module.cjs.exports = exports;
				}
			}
		});
	}

	has.add('function-bind', Boolean(Function.prototype.bind));
	if (!has('function-bind')) {
		injectModule.bind = function (thisArg: any): typeof injectModule {
			const slice = Array.prototype.slice;
			const args: any[] = slice.call(arguments, 1);

			return function (): void {
				return injectModule.apply(thisArg, args.concat(slice.call(arguments, 0)));
			};
		};
	}

	if (has('host-node')) {
		function nodeLoadModule(mid: string, parent?: Module): any {
			let module: any = require('module');
			let oldDefine = define;
			let result: any;

			if(module._findPath && module._nodeModulePaths){
				let localModulePath = module._findPath(mid, module._nodeModulePaths(toUrl('.', parent)));

				if (localModulePath !== false) {
					mid = localModulePath;
				}
			}

			// Some modules attempt to detect an AMD loader by looking for global AMD `define`. This causes issues
			// when other CommonJS modules attempt to load them via the standard Node.js `require`, so hide it
			// during the load
			define = undefined;

			try {
				result = req.nodeRequire(mid);
			}
			catch (error) {
				// If the Node.js 'require' function cannot locate a module it will throw "Error: Cannot find module"
				// Leave it to the caller of this function to handle a non-existent module (and throw an error if desired)
				result = undefined;
			}
			finally {
				define = oldDefine;
			}

			return result;
		}

		const vm: any = require('vm');
		const fs: any = require('fs');

		// retain the ability to get node's require
		req.nodeRequire = require;
		injectUrl = function (url: string, callback: (node?: HTMLScriptElement) => void, module: Module, parent?: Module): void {
			fs.readFile(url, 'utf8', function (error: Error, data: string): void {
				if (error) {
					function loadCallback () {
						let result = nodeLoadModule(module.mid, parent);

						if (!result) {
							throw new Error('Failed to load module ' + module.mid + ' from ' + url + (parent ? ' (parent: ' + parent.mid + ')' : ''));
						}

						return result;
					}

					defArgs = [ [], loadCallback ];
				}
				else {
					// global `module` variable needs to be shadowed for UMD modules that are loaded in an Electron webview;
					// in Node.js the `module` variable does not exist when using `vm.runInThisContext`, but in Electron it
					// exists in the webview when Node.js integration is enabled which causes loaded modules to register
					// with Node.js and break the loader
					var oldModule = this.module;
					this.module = undefined;
					try {
						vm.runInThisContext(data, url);
					}
					finally {
						this.module = oldModule;
					}
				}

				callback();
			});
		};

		setGlobals = function (require: Require, define: Define): void {
			module.exports = this.require = require;
			this.define = define;
		};
	}
	else if (has('host-browser')) {
		injectUrl = function (url: string, callback: (node?: HTMLScriptElement) => void, module: Module, parent?: Module): void {
			// insert a script element to the insert-point element with src=url;
			// apply callback upon detecting the script has loaded.
			const node: HTMLScriptElement = document.createElement('script');
			const handler: EventListener = function (event: Event): void {
				document.head.removeChild(node);

				if (event.type === 'load') {
					has('loader-ie9-compat') ? callback(node) : callback();
				}
				else {
					throw new Error('Failed to load module ' + module.mid + ' from ' + url + (parent ? ' (parent: ' + parent.mid + ')' : ''));
				}
			};

			node.addEventListener('load', handler, false);
			node.addEventListener('error', handler, false);

			(<any> node).crossOrigin = 'anonymous';
			node.charset = 'utf-8';
			node.src = url;
			document.head.appendChild(node);
		};

		setGlobals = function (require: Require, define: Define): void {
			this.require = require;
			this.define = define;
		};
	}
	else {
		throw new Error('Unsupported platform');
	}

	has.add('loader-debug-internals', true);
	if (has('loader-debug-internals')) {
		req.inspect = function (name: string): any {
			/* tslint:disable:no-eval */
			// TODO: Should this use console.log so people do not get any bright ideas about using this in apps?
			return eval(name);
			/* tslint:enable:no-eval */
		};
	}

	has.add('loader-undef', true);
	if (has('loader-undef')) {
		req.undef = function (id: string): void {
			if (modules[id]) {
				modules[id] = undefined;
			}
		};
	}

	mix(req, {
		toAbsMid: toAbsMid,
		toUrl: toUrl,

		cache: function (cache: { [moduleId: string]: any; }): void {
			consumePendingCacheInsert();
			pendingCacheInsert = cache;
		}
	});

	Object.defineProperty(req, 'baseUrl', {
		get: function (): string {
			return baseUrl;
		},
		enumerable: true
	});

	has.add('loader-cjs-wrapping', true);
	if (has('loader-cjs-wrapping')) {
		var comments: RegExp = /\/\*[\s\S]*?\*\/|\/\/.*$/mg;
		var requireCall: RegExp = /require\s*\(\s*(["'])(.*?[^\\])\1\s*\)/g;
	}

	has.add('loader-explicit-mid', true);

	/**
	 * @param deps //(array of commonjs.moduleId, optional)
	 * @param factory //(any)
	 */
	var define: Define = <Define> mix(function (deps: string[], factory: Factory): void {
		if (has('loader-explicit-mid') && arguments.length > 1 && typeof deps === 'string') {
			let id: string = <any> deps;
			if (arguments.length === 3) {
				deps = <any> factory;
				factory = arguments[2];
			} else {
				deps = [];
			}

			// Some modules in the wild have an explicit module ID that is null; ignore the module ID in this case and
			// register normally using the request module ID
			if (id != null) {
				let module: Module = getModule(id);
				if (factory) {
					const originalFactory = factory;
					factory = function () {
						module.executed = true;
						return (module.result = originalFactory.apply(null, arguments));
					};
				}
				module.injected = true;
				defineModule(module, deps, factory);
				guardCheckComplete(function (): void {
					forEach(module.deps, injectModule.bind(null, module));
				});
			}
		}

		if (arguments.length === 1) {
			if (has('loader-cjs-wrapping') && typeof deps === 'function') {
				let originalFactory = <any> deps;
				deps = [ 'require', 'exports', 'module' ];

				// Scan factory for require() calls and add them to the
				// list of dependencies
				originalFactory.toString()
					.replace(comments, '')
					.replace(requireCall, function (): string {
						deps.push(/* mid */ arguments[2]);
						return arguments[0];
					});
				factory = function (require, exports, module): any {
					const originalMid = module.id;
					originalFactory.apply(null, arguments);
					if (originalMid !== module.id) {
						const newModule: Module = getModule(module.id);
						defineModule(newModule, deps, null);
						newModule.injected = true;
						newModule.executed = true;
						newModule.result = module.exports;
					}
				}
			}
			else if (/* define(value) */ !Array.isArray(deps)) {
				const value: any = deps;
				deps = [];
				factory = function (): any {
					return value;
				};
			}
		}

		if (has('loader-ie9-compat')) {
			for (var i = document.scripts.length - 1, script: HTMLScriptElement; (script = <HTMLScriptElement> document.scripts[i]); --i) {
				if ((<any> script).readyState === 'interactive') {
					(<any> script).defArgs = [ deps, factory ];
					break;
				}
			}
		}
		else {
			defArgs = [ deps, factory ];
		}
	}, {
		amd: { vendor: 'dojotoolkit.org' }
	});

	setGlobals(req, define);
})();
