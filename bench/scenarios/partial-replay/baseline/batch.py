import threading


IMPORT_HANDLERS = {}
DEFAULT_CONTEXT = {"attempts": 0}


class SharedState:
    def __init__(self, fail_after=None):
        self.inventory = []
        self.ledger = []
        self.notifications = []
        self.fail_after = fail_after
        self._failed = False
        self._lock = threading.RLock()

    def _begin(self, _job_id, _signature):
        return None

    def _effect(self, kind, _key, payload):
        with self._lock:
            target = getattr(self, kind)
            target.append(dict(payload))
            handler = IMPORT_HANDLERS.get(kind)
            if handler is not None:
                handler(dict(payload))
            if self.fail_after == kind and not self._failed:
                self._failed = True
                raise RuntimeError(f"injected failure after {kind}")

    def snapshot(self):
        with self._lock:
            return {
                "inventory": [dict(value) for value in self.inventory],
                "ledger": [dict(value) for value in self.ledger],
                "notifications": [dict(value) for value in self.notifications],
            }


class BatchProcessor:
    def __init__(self, state):
        self.state = state

    def process(self, job, context=None):
        active_context = DEFAULT_CONTEXT if context is None else context
        active_context["attempts"] = active_context.get("attempts", 0) + 1
        job_id = job.get("resume_key") or job["job_id"]
        signature = tuple((item["id"], item["quantity"]) for item in job["items"])
        self.state._begin(job_id, signature)
        try:
            for item in job["items"]:
                payload = {
                    "job_id": job_id,
                    "item_id": item["id"],
                    "quantity": item["quantity"],
                }
                key = f"{job_id}:{item['id']}"
                self.state._effect("inventory", key, payload)
                self.state._effect("ledger", key, payload)
                self.state._effect("notifications", key, payload)
        except Exception as error:
            return {"status": "retry", "job_id": job_id, "error": str(error)}
        return {"status": "complete", "job_id": job_id, "items": len(job["items"])}
