"""Connectors that run only inside an agent in its owner's own cloud account.

Nothing in this package may be imported by the shared hub. Modules here refuse at
import time unless the process is a pod (``pod_mode()``) placed in the owner's own
cloud (``pod_owner_cloud.owner_cloud_agent()``).
"""
