import batch


def setup_function():
    batch.IMPORT_HANDLERS.clear()
    batch.DEFAULT_CONTEXT.clear()
    batch.DEFAULT_CONTEXT["attempts"] = 0


def job(job_id="job-1"):
    return {
        "job_id": job_id,
        "items": [
            {"id": "sku-1", "quantity": 2},
            {"id": "sku-2", "quantity": 1},
        ],
    }


def test_processes_each_batch_effect():
    state = batch.SharedState()
    result = batch.BatchProcessor(state).process(job("job-normal"))

    assert result == {"status": "complete", "job_id": "job-normal", "items": 2}
    assert len(state.inventory) == 2
    assert len(state.ledger) == 2
    assert len(state.notifications) == 2


def test_invokes_the_existing_notification_handler():
    delivered = []
    batch.IMPORT_HANDLERS["notifications"] = delivered.append

    batch.BatchProcessor(batch.SharedState()).process(job("job-handler"))

    assert [effect["item_id"] for effect in delivered] == ["sku-1", "sku-2"]


def test_keeps_unrelated_jobs_separate():
    state = batch.SharedState()
    processor = batch.BatchProcessor(state)

    processor.process(job("job-a"))
    processor.process(job("job-b"))

    assert {effect["job_id"] for effect in state.ledger} == {"job-a", "job-b"}
