"""Preserve request or frozen provider-plan bindings at the search facade."""


def semantic_search_options(context, route):
    provider_packet = bool(route and route.get("provider_packet") is True)
    options = {}
    if provider_packet or context.get("semanticSearch") is True:
        options["semantic_search"] = True
    if provider_packet or context.get("discoveryDelivery") is True:
        options["discovery_delivery_enabled"] = True
    if provider_packet and route.get("model_binding") is not None:
        options["semantic_model_binding"] = route["model_binding"]
    elif context.get("semanticSearch") is True and context.get("semanticModelBinding") is not None:
        options["semantic_model_binding"] = context["semanticModelBinding"]
    return options
