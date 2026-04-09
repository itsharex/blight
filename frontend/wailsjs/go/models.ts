export namespace files {

	export class IndexStatus {
	    state: string;
	    message: string;
	    count: number;
	    total: number;

	    static createFrom(source: any = {}) {
	        return new IndexStatus(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.state = source["state"];
	        this.message = source["message"];
	        this.count = source["count"];
	        this.total = source["total"];
	    }
	}

}

export namespace main {

	export class BlightConfig {
	    firstRun: boolean;
	    hotkey: string;
	    maxClipboard: number;
	    indexDirs?: string[];
	    maxResults: number;
	    searchDelay: number;
	    hideWhenDeactivated: boolean;
	    lastQueryMode: string;
	    windowPosition: string;
	    useAnimation: boolean;
	    showPlaceholder: boolean;
	    placeholderText: string;
	    theme: string;
	    startOnStartup: boolean;
	    hideNotifyIcon: boolean;

	    static createFrom(source: any = {}) {
	        return new BlightConfig(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.firstRun = source["firstRun"];
	        this.hotkey = source["hotkey"];
	        this.maxClipboard = source["maxClipboard"];
	        this.indexDirs = source["indexDirs"];
	        this.maxResults = source["maxResults"];
	        this.searchDelay = source["searchDelay"];
	        this.hideWhenDeactivated = source["hideWhenDeactivated"];
	        this.lastQueryMode = source["lastQueryMode"];
	        this.windowPosition = source["windowPosition"];
	        this.useAnimation = source["useAnimation"];
	        this.showPlaceholder = source["showPlaceholder"];
	        this.placeholderText = source["placeholderText"];
	        this.theme = source["theme"];
	        this.startOnStartup = source["startOnStartup"];
	        this.hideNotifyIcon = source["hideNotifyIcon"];
	    }
	}
	export class ContextAction {
	    id: string;
	    label: string;
	    icon: string;

	    static createFrom(source: any = {}) {
	        return new ContextAction(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.label = source["label"];
	        this.icon = source["icon"];
	    }
	}
	export class SearchResult {
	    id: string;
	    title: string;
	    subtitle: string;
	    icon: string;
	    category: string;
	    path: string;

	    static createFrom(source: any = {}) {
	        return new SearchResult(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.title = source["title"];
	        this.subtitle = source["subtitle"];
	        this.icon = source["icon"];
	        this.category = source["category"];
	        this.path = source["path"];
	    }
	}
	export class UpdateInfo {
	    available: boolean;
	    version: string;
	    url: string;
	    notes: string;
	    error?: string;

	    static createFrom(source: any = {}) {
	        return new UpdateInfo(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.available = source["available"];
	        this.version = source["version"];
	        this.url = source["url"];
	        this.notes = source["notes"];
	        this.error = source["error"];
	    }
	}

}
