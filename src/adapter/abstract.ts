import type { Logger } from "@marianmeres/clog";

export interface SetOptions extends Record<string, any> {
	ttl: number; // in seconds!
}

export interface AdapterInfo {
	type: string;
	// ... todo list features
}

export interface AdapterAbstractOptions extends Record<string, any> {
	defaultTtl: number; // in seconds
	logger?: Logger;
}

export interface Operation {
	type: "set" | "get" | "delete";
	key: string;
	value?: any;
	options?: Partial<SetOptions>;
}

function notImplemented(): any {
	throw new Error("Not implemented");
}

/** Abstract adapter definition */
export abstract class AdapterAbstract {
	protected _type: string = "abstract";

	readonly options: AdapterAbstractOptions = {
		defaultTtl: 0, // no ttl by default
	};

	protected _initialized: boolean = false;

	constructor(
		/**
		 * "Namespace" is a instance **internal** key prefix. Internal means it acts as a low
		 * level namespace (similar to db schema), not something you consider when working
		 * with kv pairs
		 */
		public readonly namespace: string = "",
		options: Partial<AdapterAbstractOptions> = {}
	) {
		this.options = { ...this.options, ...(options || {}) };
		this._assertValidNamespace();
	}

	protected _assertInitialized() {
		if (!this._initialized) {
			throw new Error("Client does not appear to be initialized");
		}
	}

	protected _assertValidNamespace() {
		if (this.namespace && !this.namespace.endsWith(":")) {
			throw new TypeError(
				`Namespace must be either empty, or must end with a colon ("${this.namespace}")`
			);
		}
	}

	protected _withNs(key: string) {
		return this.namespace + key;
	}

	protected _withoutNs(key: string) {
		if (this.namespace) key = key.slice(this.namespace.length);
		return key;
	}

	/** Will connect the client instance to underlying store (if applicable) */
	abstract initialize(): Promise<void>;

	/** Will disconnect the client instance from underlying store (if applicable) */
	abstract destroy(hard?: boolean): Promise<void>;

	/** Will set key-value pair to the underlying store with given options */
	set(
		key: string,
		value: any,
		options?: Partial<SetOptions>
	): Promise<boolean> {
		return notImplemented();
	}

	/** Will get the key from the underlying store */
	get(key: string): Promise<any> {
		return notImplemented();
	}

	/** Will delete the key from the underlying store */
	delete(key: string): Promise<boolean> {
		return notImplemented();
	}

	/** Will check if the key exists in the underlying store */
	exists(key: string): Promise<boolean> {
		return notImplemented();
	}

	/** Will list all existing keys in the underlying store matching given pattern.
	 * Recognizes redis-like star wildcard format. */
	keys(pattern: string): Promise<string[]> {
		return notImplemented();
	}

	/** Will clear all existing keys in the underlying store matching given pattern.
	 * Recognizes redis-like star wildcard format. */
	clear(pattern: string): Promise<number> {
		return notImplemented();
	}

	/** Will set multiple kv pairs in one batch */
	setMultiple(
		keyValuePairs: [string, any][],
		options?: Partial<SetOptions>
	): Promise<any[]> {
		return notImplemented();
	}

	/** Will get multiple keys in one batch */
	getMultiple(keys: string[]): Promise<Record<string, any>> {
		return notImplemented();
	}

	/** Will do multiple operations within one transaction (where applicable) */
	transaction(operations: Operation[]): Promise<any[]> {
		return notImplemented();
	}

	/** Will set the expiration ttl on the given key to given ttl value */
	expire(key: string, ttl: number): Promise<boolean> {
		return notImplemented();
	}

	/** Will get the expiration Date for given key */
	ttl(key: string): Promise<Date | null | false> {
		return notImplemented();
	}

	/** Will get info about the current adapter instance */
	info(): AdapterInfo {
		return {
			type: this._type,
			// ... todo: list features
		};
	}

	/** Will dump all data for debugging purposes only. Use with caution. Intended for
	 * tests only */
	__debug_dump(): Promise<
		Record<string, { value: any; ttl: Date | null | false }>
	> {
		return notImplemented();
	}
}
