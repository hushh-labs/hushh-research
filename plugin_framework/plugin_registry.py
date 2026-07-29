PLUGIN_REGISTRY = []


def register_plugin(plugin_name):

    PLUGIN_REGISTRY.append(plugin_name)

    return {
        "plugin_registered": True,
        "plugin_name": plugin_name
    }