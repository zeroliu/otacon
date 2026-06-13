// In-process pub/sub bridging daemon state changes to the web UI's SSE
// streams (DESIGN.md §10 "UI updates over SSE"). One daemon process owns all
// state, so an EventEmitter is the entire bus (DECISIONS.md "UI live updates:
// in-process Notifier, snapshot-first SSE, no replay").
import { EventEmitter } from "node:events";
export class Notifier {
    emitter = new EventEmitter();
    constructor() {
        // One listener per open SSE stream; the default 10-listener warning is noise.
        this.emitter.setMaxListeners(0);
    }
    publish(event) {
        this.emitter.emit("event", event);
    }
    /** Returns the unsubscribe function. */
    subscribe(listener) {
        this.emitter.on("event", listener);
        return () => {
            this.emitter.off("event", listener);
        };
    }
}
//# sourceMappingURL=notify.js.map