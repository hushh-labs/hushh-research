def validate_workflow(result):

    return {
        "workflow_valid": not result["workflow_blocked"]
    }