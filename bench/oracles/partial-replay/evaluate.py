import copy
import importlib.util
import inspect
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


ROOT = Path(sys.argv[1]).resolve()
CHECKS = []


def load_module(label):
    spec = importlib.util.spec_from_file_location(f"candidate_{label}", ROOT / "batch.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sample_job(job_id="job-1", quantity=2, resume_key=None):
    value = {
        "job_id": job_id,
        "items": [{"id": "sku-1", "quantity": quantity}],
    }
    if resume_key is not None:
        value["resume_key"] = resume_key
    return value


def assert_once(state, count=1):
    snapshot = state.snapshot()
    for kind in ("inventory", "ledger", "notifications"):
        values = snapshot[kind]
        assert len(values) == count, f"expected {count} {kind} effects, got {len(values)}"


def check(check_id, category, operation):
    try:
        operation()
        CHECKS.append({"id": check_id, "category": category, "passed": True, "detail": "passed"})
    except Exception as error:
        CHECKS.append(
            {"id": check_id, "category": category, "passed": False, "detail": str(error)}
        )


def partial_boundary_replay():
    module = load_module("boundaries")
    for boundary in ("inventory", "ledger", "notifications"):
        state = module.SharedState(boundary)
        first = module.BatchProcessor(state).process(sample_job(f"job-{boundary}"))
        assert first["status"] == "retry", f"{boundary} failure was not retryable"
        second = module.BatchProcessor(state).process(sample_job(f"job-{boundary}"))
        assert second["status"] == "complete", f"{boundary} replay did not complete"
        assert_once(state)


def cross_instance_replay():
    module = load_module("instances")
    state = module.SharedState("ledger")
    module.BatchProcessor(state).process(sample_job())
    result = module.BatchProcessor(state).process(sample_job())
    assert result["status"] == "complete", "new processor did not resume"
    assert_once(state)


def concurrent_replay():
    module = load_module("concurrent")
    state = module.SharedState()
    processors = [module.BatchProcessor(state), module.BatchProcessor(state)]
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda processor: processor.process(sample_job()), processors))
    assert all(result["status"] == "complete" for result in results), "concurrent replay failed"
    assert_once(state)


def input_conflict():
    module = load_module("conflict")
    state = module.SharedState()
    processor = module.BatchProcessor(state)
    processor.process(sample_job(quantity=2))
    before = state.snapshot()
    try:
        processor.process(sample_job(quantity=9))
    except ValueError:
        pass
    else:
        raise AssertionError("changed input did not raise ValueError")
    assert state.snapshot() == before, "conflict added an effect"


def resume_key_isolation():
    module = load_module("smuggling")
    state = module.SharedState()
    processor = module.BatchProcessor(state)
    processor.process(sample_job("job-a", resume_key="shared"))
    processor.process(sample_job("job-b", resume_key="shared"))
    assert {entry["job_id"] for entry in state.ledger} == {"job-a", "job-b"}, "resume_key leaked"


def callback_exactly_once():
    module = load_module("callback")
    delivered = []
    module.IMPORT_HANDLERS["notifications"] = delivered.append
    state = module.SharedState("notifications")
    module.BatchProcessor(state).process(sample_job())
    module.BatchProcessor(state).process(sample_job())
    assert len(delivered) == 1, f"expected one callback, got {len(delivered)}"


def state_isolation():
    module = load_module("stores")
    first = module.SharedState()
    second = module.SharedState()
    module.BatchProcessor(first).process(sample_job())
    module.BatchProcessor(second).process(sample_job())
    assert_once(first)
    assert_once(second)


def input_immutability():
    module = load_module("immutability")
    job = sample_job()
    context = {"request_id": "request-1"}
    before_job = copy.deepcopy(job)
    before_context = copy.deepcopy(context)
    module.BatchProcessor(module.SharedState()).process(job, context)
    assert job == before_job, "job input was mutated"
    assert context == before_context, "context input was mutated"
    assert module.DEFAULT_CONTEXT == {"attempts": 0}, "module default context changed"


def public_api():
    module = load_module("api")
    assert str(inspect.signature(module.SharedState)) == "(fail_after=None)", "SharedState API changed"
    assert str(inspect.signature(module.BatchProcessor)) == "(state)", "BatchProcessor API changed"
    assert str(inspect.signature(module.BatchProcessor.process)) == "(self, job, context=None)", (
        "process API changed"
    )


check("partial-boundary-replay", "acceptance", partial_boundary_replay)
check("cross-instance-replay", "acceptance", cross_instance_replay)
check("concurrent-replay", "acceptance", concurrent_replay)
check("input-conflict", "acceptance", input_conflict)
check("resume-key-isolation", "acceptance", resume_key_isolation)
check("callback-exactly-once", "acceptance", callback_exactly_once)
check("state-isolation", "acceptance", state_isolation)
check("input-immutability", "preservation", input_immutability)
check("public-api", "scope", public_api)
print(json.dumps({"checks": CHECKS}, sort_keys=True))
