from plugin_registry import PLUGIN_REGISTRY


def load_plugins():

    return {
        "loaded_plugins": PLUGIN_REGISTRY,
        "plugin_count": len(PLUGIN_REGISTRY)
    }