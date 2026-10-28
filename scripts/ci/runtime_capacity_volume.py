"""Bounded, in-memory inspection of projected Dev route configuration."""

import json
import posixpath
import re


class VolumeInspector:
    def __init__(
        self,
        workload,
        aliases,
        reader,
        pending,
        walk,
        reference,
        observe,
        payload,
        error,
    ):
        self.workload, self.aliases, self.reader, self.pending = (
            workload,
            aliases,
            reader,
            pending,
        )
        self.walk, self.reference, self.observe, self.payload, self.error = (
            walk,
            reference,
            observe,
            payload,
            error,
        )
        self.versions = set()

    def fail(self):
        raise self.error("unresolved non-target volume routing")

    def projected_paths(self):
        result = {}
        for spec in self.walk(self.workload):
            if not isinstance(spec, dict) or not isinstance(
                spec.get("containers"), list
            ):
                continue
            volumes = spec.get("volumes", [])
            if not isinstance(volumes, list):
                self.fail()
            by_name = {v.get("name"): v for v in volumes if isinstance(v, dict)}
            if len(by_name) != len(volumes):
                self.fail()
            for container in spec["containers"]:
                if not isinstance(container, dict):
                    self.fail()
                paths = set()
                for mount in container.get("volumeMounts", []):
                    if not isinstance(mount, dict) or set(mount) - {
                        "name",
                        "mountPath",
                    }:
                        continue
                    path, secret = (
                        mount.get("mountPath"),
                        by_name.get(mount.get("name"), {}).get("secret", {}),
                    )
                    if (
                        not isinstance(path, str)
                        or not path.startswith("/")
                        or posixpath.normpath(path) != path
                        or not isinstance(secret, dict)
                        or not isinstance(secret.get("items"), list)
                    ):
                        continue
                    for item in secret["items"]:
                        if isinstance(item, dict) and isinstance(item.get("path"), str):
                            relative = item["path"]
                            if (
                                not relative.startswith("/")
                                and posixpath.normpath(relative) == relative
                            ):
                                paths.add(posixpath.join(path, relative))
                for entry in container.get("env", []):
                    if isinstance(entry, dict):
                        result[id(entry)] = paths
        return result

    @staticmethod
    def unique_pairs(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate key")
            result[key] = value
        return result

    def validate_config(self, payload, inspect, decoded):
        inspect(payload)
        try:
            config = json.loads(payload, object_pairs_hook=self.unique_pairs)
        except (TypeError, ValueError):
            self.fail()
        if not isinstance(config, dict):
            self.fail()
        for section in self.walk(config):
            if isinstance(section, dict):
                for key, value in section.items():
                    if re.search(
                        r"(?:base64|encoded|compressed|encrypted|include|import|reference)",
                        str(key),
                        re.I,
                    ):
                        self.fail()
                    if isinstance(value, str) and re.search(
                        r"(?:config|setting)", str(key), re.I
                    ):
                        self.fail()
            if isinstance(section, str) and (
                "$" in decoded(section) or section.lstrip().startswith(("{", "["))
            ):
                self.fail()
        inspect(config)

    def inspect_item(self, secret, item, paths, inspect, decoded):
        if (
            not isinstance(item, dict)
            or set(item) != {"key", "path"}
            or not isinstance(item["key"], str)
            or not re.fullmatch(r"latest|[1-9][0-9]*", item["key"])
            or not isinstance(item["path"], str)
            or not re.fullmatch(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*", item["path"])
            or any(part in {".", ".."} for part in item["path"].split("/"))
            or item["path"] in paths
        ):
            self.fail()
        paths.add(item["path"])
        ref = self.reference(
            self.workload,
            {"name": secret["secretName"], "key": item["key"]},
            self.aliases,
        )
        node = {"valueFrom": {"secretKeyRef": ref}}
        resolved = self.observe(self.reader, self.workload, node, "hushh-pda-dev")
        self.validate_config(
            self.payload(resolved, ref, self.aliases), inspect, decoded
        )
        self.versions.add(resolved.resource_name)
        if item["key"] == "latest":
            self.pending.append((self.workload, node, resolved.resource_name))

    def inspect_node(self, node, inspect, decoded):
        if "volumes" in node and not isinstance(node["volumes"], list):
            self.fail()
        volumes = node.get("volumes", [])
        if not volumes:
            return
        if len(volumes) > 32 or self.reader is None:
            self.fail()
        names = set()
        for volume in volumes:
            if not isinstance(volume, dict) or set(volume) != {"name", "secret"}:
                self.fail()
            name, secret = volume["name"], volume["secret"]
            if (
                not isinstance(name, str)
                or not re.fullmatch(r"[A-Za-z0-9_-]{1,253}", name)
                or name in names
                or not isinstance(secret, dict)
                or set(secret) != {"secretName", "items"}
                or not isinstance(secret["items"], list)
                or not 1 <= len(secret["items"]) <= 32
            ):
                self.fail()
            names.add(name)
            paths = set()
            for item in secret["items"]:
                self.inspect_item(secret, item, paths, inspect, decoded)
