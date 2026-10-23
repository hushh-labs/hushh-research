"""Fit the Drive four-group organizing aid from labelled examples and write its data files.

    python scripts/train_drive_groups.py [--fixtures PATH] [--cache-dir DIR]

Trains on the ``train`` split only; the ``eval`` split is never read here, so
``eval_drive_groups.py`` measures files the fit has not seen. The fusion weights
and the placement thresholds are fitted on out-of-fold predictions, where each
fold holds out whole template families (a layout the fit has not seen), so the
confidence it learns is not flattered by near-copies. The thresholds are the
loosest that still reach the target precision on those predictions: a wrong
inclusion is worse than a miss. Nothing is hand-weighted.

Uses scikit-learn and scipy for fitting only. Both already ship in the backend
image as dependencies of sentence-transformers; neither is imported at runtime.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
from drive_group_lab import DEFAULT_CACHE, DEFAULT_FIXTURES, CachedEmbedder, load_rows
from scipy import sparse
from scipy.optimize import minimize
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold

from hushh_mcp.services.drive_groups.contract import (
    CLASSES,
    GROUP_IDS,
    NONE_CLASS,
    SIGNALS,
    SignalReading,
)
from hushh_mcp.services.drive_groups.embedding_model import EmbeddingModel
from hushh_mcp.services.drive_groups.features import metadata_features, text_features
from hushh_mcp.services.drive_groups.fusion import FusionPolicy, fuse, pooled
from hushh_mcp.services.drive_groups.linear_model import LinearModel, tfidf_vector
from hushh_mcp.services.drive_groups.models import DATA_FILES, version_of
from hushh_mcp.services.drive_groups.text_head import HEAD_CHARS
from hushh_mcp.services.embedding_client_leaf import MODEL_ID, MODEL_REVISION

DATA_DIR = Path(__file__).resolve().parents[1] / "hushh_mcp" / "services" / "drive_groups" / "data"
# The written meaning of each group is the only label-free evidence the aid has.
DEFINITIONS = {
    "financial_statements": (
        "Statements for money accounts and transactions: bank, credit card, brokerage, loan, tax."
    ),
    "non_financial_statements": (
        "Account, usage or record statements that are not about money accounts or insurance: "
        "utilities, telecom, medical, education transcripts."
    ),
    "insurance_statements": (
        "Insurance policies, premium notices and claim statements: health, life, vehicle, property."
    ),
    "personal_documents": (
        "Identity and personal records: passports, ID cards, certificates, resumes, letters, forms."
    ),
}
TARGET_PRECISION = 0.98
MIN_FAMILIES = 3
# A signal the fit found hardly any use for gets no weight, so it casts no vote either.
MIN_WEIGHT = 0.05
EMBEDDING_C = 0.1
FOLDS = 4
FLOOR = 1e-6


def family_of(row: dict) -> str:
    """Fixture rows name their template family; real labels without one count as their own."""
    return str(row.get("family") or row["id"])


def label_index(rows: list[dict]) -> np.ndarray:
    return np.array([CLASSES.index(row["label"]) for row in rows])


def fit_linear(
    counts: list,
    labels: np.ndarray,
    families: list[str],
    *,
    c: float,
    max_features: int,
    min_families: int = MIN_FAMILIES,
) -> dict:
    """A tf-idf softmax-linear model as the JSON payload ``LinearModel`` reads.

    A feature is kept only when it occurs in at least ``min_families`` distinct
    template families (layouts, issuers or sources), so the model learns what a
    kind of document looks like, not the quirks of one layout.
    """
    total = len(counts)
    document_frequency = Counter(feature for row in counts for feature in row)
    family_support = Counter(
        feature
        for feature, _ in {(f, fam) for row, fam in zip(counts, families, strict=True) for f in row}
    )
    vocabulary = [
        feature
        for feature, count in document_frequency.most_common()
        if family_support[feature] >= min_families
    ][:max_features]
    index = {feature: position for position, feature in enumerate(vocabulary)}
    idf = {
        feature: math.log((1 + total) / (1 + document_frequency[feature])) + 1
        for feature in vocabulary
    }
    entries = [
        (row, index[feature], value)
        for row, bag in enumerate(counts)
        for feature, value in tfidf_vector(bag, idf).items()
    ]
    matrix = sparse.csr_matrix(
        ([e[2] for e in entries], ([e[0] for e in entries], [e[1] for e in entries])),
        shape=(total, len(vocabulary)),
    )
    model = LogisticRegression(C=c, max_iter=5000, class_weight="balanced").fit(matrix, labels)
    coefficients = np.full((len(CLASSES), len(vocabulary)), 0.0)
    intercept = np.full(len(CLASSES), -12.0)
    for position, klass in enumerate(model.classes_):
        coefficients[klass] = model.coef_[position]
        intercept[klass] = model.intercept_[position]
    return {
        "kind": "linear_v1",
        "classes": list(CLASSES),
        "intercept": [round(float(v), 5) for v in intercept],
        "features": {
            feature: [round(idf[feature], 5), *(round(float(w), 5) for w in coefficients[:, i])]
            for i, feature in enumerate(vocabulary)
        },
    }


def unit(matrix: np.ndarray) -> np.ndarray:
    return matrix / np.linalg.norm(matrix, axis=-1, keepdims=True)


def similarity_features(
    vectors: np.ndarray, labels: np.ndarray | None, sums: np.ndarray, definitions: np.ndarray
) -> np.ndarray:
    """Cosine to each class centroid then to each definition; the own class is left out of its own row."""
    centroids = unit(sums)
    to_class = vectors @ centroids.T
    if labels is not None:
        for row, klass in enumerate(labels):
            rest = sums[klass] - vectors[row]
            norm = np.linalg.norm(rest)
            to_class[row, klass] = float(vectors[row] @ rest) / norm if norm else 0.0
    return np.hstack([to_class, vectors @ definitions.T])


def fit_embedding(vectors: np.ndarray, labels: np.ndarray, definitions: np.ndarray) -> dict:
    sums = np.stack(
        [
            vectors[labels == klass].sum(axis=0)
            if (labels == klass).any()
            else np.eye(vectors.shape[1])[0]
            for klass in range(len(CLASSES))
        ]
    )
    features = similarity_features(vectors, labels, sums, definitions)
    mean, scale = features.mean(axis=0), features.std(axis=0) + 1e-6
    model = LogisticRegression(C=EMBEDDING_C, max_iter=5000, class_weight="balanced").fit(
        (features - mean) / scale, labels
    )
    weights = np.zeros((len(CLASSES), features.shape[1]))
    intercept = np.full(len(CLASSES), -12.0)
    for position, klass in enumerate(model.classes_):
        weights[klass], intercept[klass] = model.coef_[position], model.intercept_[position]
    return {
        "kind": "embedding_v1",
        "classes": list(CLASSES),
        "centroids": [[round(float(v), 6) for v in row] for row in unit(sums)],
        "definitions": [[round(float(v), 6) for v in row] for row in definitions],
        "mean": [round(float(v), 6) for v in mean],
        "scale": [round(float(v), 6) for v in scale],
        "weights": [[round(float(v), 6) for v in row] for row in weights],
        "intercept": [round(float(v), 6) for v in intercept],
    }


def signal_payloads(rows, vectors, labels, definitions) -> tuple[dict, dict, dict]:
    """Fit the text, metadata and embedding signals on these rows; returns their JSON payloads."""
    with_head = [i for i, row in enumerate(rows) if row.get("head")]
    text = fit_linear(
        [text_features(rows[i]["head"]) for i in with_head],
        labels[with_head],
        [family_of(rows[i]) for i in with_head],
        c=3.0,
        max_features=5000,
    )
    metadata = fit_linear(
        [metadata_features(r["name"], r["mime"]) for r in rows],
        labels,
        [family_of(r) for r in rows],
        c=3.0,
        max_features=3000,
    )
    embedding = fit_embedding(vectors[with_head], labels[with_head], definitions)
    return text, metadata, embedding


def models_from(payloads) -> tuple[LinearModel, LinearModel, EmbeddingModel]:
    text, metadata, embedding = payloads
    return (
        LinearModel.from_payload(text),
        LinearModel.from_payload(metadata),
        EmbeddingModel.from_payload(embedding),
    )


def readings_of(row, vector, models) -> tuple[SignalReading, ...]:
    text, metadata, embedding = models
    return (
        SignalReading(
            "text", text.probabilities(text_features(row["head"])) if row.get("head") else None
        ),
        SignalReading(
            "embedding",
            embedding.probabilities(tuple(vector.tolist())) if row.get("head") else None,
        ),
        SignalReading(
            "metadata",
            metadata.probabilities(
                metadata_features(
                    row["name"],
                    row["mime"],
                    owned_by_me=row["owned_by_me"],
                    shared_with_me=row["shared_with_me"],
                )
            ),
        ),
    )


def fit_weights(readings: list[tuple[SignalReading, ...]], labels: np.ndarray) -> np.ndarray:
    """Non-negative per-signal weights minimising the negative log likelihood of the pooled posterior."""
    logs = np.zeros((len(SIGNALS), len(readings), len(CLASSES)))
    for row, group in enumerate(readings):
        for signal, reading in enumerate(group):
            if reading.probabilities is not None:
                logs[signal, row] = np.log(np.maximum(reading.probabilities, FLOOR))

    def loss(weights: np.ndarray) -> float:
        scores = np.tensordot(weights, logs, axes=1)
        scores = scores - scores.max(axis=1, keepdims=True)
        log_posterior = scores - np.log(np.exp(scores).sum(axis=1, keepdims=True))
        return float(
            -log_posterior[np.arange(len(labels)), labels].mean() + 1e-3 * (weights**2).sum()
        )

    weights = minimize(loss, np.full(len(SIGNALS), 0.5), bounds=[(0.0, 6.0)] * len(SIGNALS)).x
    return np.where(weights < MIN_WEIGHT, 0.0, weights)


def fit_calibration(readings, labels, weights) -> tuple[float, float]:
    """Platt map from the pooled probability of the best class to P(that class is right)."""
    probe = FusionPolicy(tuple(weights), 1.0, 0.0, 0.5, 0.0, 1)
    logits, correct = [], []
    for group, klass in zip(readings, labels, strict=True):
        posterior = pooled(group, probe)
        if posterior is None:
            continue
        best = int(np.argmax(posterior))
        top = min(max(float(posterior[best]), FLOOR), 1 - FLOOR)
        logits.append(math.log(top / (1 - top)))
        correct.append(int(best == klass))
    model = LogisticRegression(C=100.0).fit(np.array(logits).reshape(-1, 1), correct)
    return float(model.coef_[0][0]), float(model.intercept_[0])


def score_policy(readings, labels, policy) -> dict:
    placed = right = wrong_none = 0
    positives = sum(1 for klass in labels if CLASSES[klass] != NONE_CLASS)
    for group, klass in zip(readings, labels, strict=True):
        result = fuse(group, policy, "")
        if result.group is None:
            continue
        placed += 1
        if result.group == CLASSES[klass]:
            right += 1
        elif CLASSES[klass] == NONE_CLASS:
            wrong_none += 1
    return {
        "placed": placed,
        "precision": right / placed if placed else 1.0,
        "recall": right / positives if positives else 0.0,
        "none_placed": wrong_none,
    }


def choose_policy(readings, labels, weights, calibration) -> tuple[FusionPolicy, dict]:
    best, best_key = None, None
    for confidence in np.arange(0.50, 0.9951, 0.025):
        for margin in (0.0, 0.1, 0.2, 0.3, 0.4, 0.5):
            for agreement in (2, 3):
                policy = FusionPolicy(
                    tuple(weights), *calibration, round(float(confidence), 3), margin, agreement
                )
                metrics = score_policy(readings, labels, policy)
                feasible = metrics["precision"] >= TARGET_PRECISION
                key = (
                    feasible,
                    metrics["recall"] if feasible else metrics["precision"],
                    confidence,
                    margin,
                    agreement,
                )
                if best_key is None or key > best_key:
                    best, best_key = (policy, metrics), key
    return best


def write(out: Path, name: str, payload: dict, *, compact: bool) -> None:
    out.mkdir(parents=True, exist_ok=True)
    text = (
        json.dumps(payload, separators=(",", ":"), sort_keys=True, ensure_ascii=False)
        if compact
        else json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False)
    )
    # Bytes, so the file is the same on every platform and so is its hash.
    (out / name).write_bytes((text + "\n").encode("utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--fixtures", type=Path, default=DEFAULT_FIXTURES)
    parser.add_argument("--cache-dir", type=Path, default=DEFAULT_CACHE)
    parser.add_argument(
        "--output-dir",
        type=Path,
        help="where to write the data files; required unless fitting the synthetic fixtures",
    )
    args = parser.parse_args()
    # A fit on real labels holds words from real documents. It must never land
    # in the repository by default, so the packaged data is only ever written
    # from the committed synthetic fixtures.
    if args.output_dir is None and args.fixtures.resolve() != DEFAULT_FIXTURES.resolve():
        parser.error("--output-dir is required when fitting anything but the synthetic fixtures")
    out = args.output_dir or DATA_DIR
    rows = load_rows(args.fixtures, "train")
    labels = label_index(rows)
    embedder = CachedEmbedder(args.cache_dir)
    vectors = np.zeros((len(rows), 384))
    heads = [i for i, row in enumerate(rows) if row.get("head")]
    vectors[heads] = embedder.passages([rows[i]["head"] for i in heads])
    definitions = embedder.queries([DEFINITIONS[group] for group in GROUP_IDS])

    families = [family_of(row) for row in rows]
    folds = FOLDS
    oof: list = [None] * len(rows)
    for train, held in GroupKFold(n_splits=folds).split(rows, labels, groups=families):
        models = models_from(
            signal_payloads([rows[i] for i in train], vectors[train], labels[train], definitions)
        )
        for i in held:
            oof[i] = readings_of(rows[i], vectors[i], models)
    weights = fit_weights(oof, labels)
    calibration = fit_calibration(oof, labels, weights)
    policy, metrics = choose_policy(oof, labels, weights, calibration)
    print(
        f"out-of-fold ({folds} family folds): {json.dumps({k: round(v, 4) if isinstance(v, float) else v for k, v in metrics.items()})}"
    )
    print(f"weights text={weights[0]:.3f} embedding={weights[1]:.3f} metadata={weights[2]:.3f}")
    print(
        f"policy min_confidence={policy.min_confidence} min_margin={policy.min_margin} min_agreement={policy.min_agreement}"
    )

    text, metadata, embedding = signal_payloads(rows, vectors, labels, definitions)
    write(out, "text_model.json", text, compact=True)
    write(out, "metadata_model.json", metadata, compact=True)
    write(out, "embedding_model.json", embedding, compact=True)
    write(
        out,
        "groups.json",
        {"kind": "groups_v1", "head_chars": HEAD_CHARS, "groups": DEFINITIONS},
        compact=False,
    )
    synthetic = args.fixtures.resolve() == DEFAULT_FIXTURES.resolve()
    provenance = {
        "fitted_on": "train split of the synthetic fixtures"
        if synthetic
        else "train split of a private labelled file",
        "fixtures_sha256": hashlib.sha256(
            args.fixtures.read_bytes().replace(b"\r\n", b"\n")
        ).hexdigest()[:16],
        "rows": len(rows),
        "folds": f"{folds} folds that hold out whole template families",
        "target_precision": TARGET_PRECISION,
        "embedding_model": f"{MODEL_ID}@{MODEL_REVISION}",
        "fitted_at": datetime.now(UTC).strftime("%Y-%m-%d"),
        "note": "Synthetic data: a regression gate, not accuracy on a real Drive."
        if synthetic
        else "Fitted on private labels; keep these files out of the repository.",
    }
    write(
        out,
        "fusion.json",
        {
            "weights": {
                signal: round(float(weight), 5)
                for signal, weight in zip(SIGNALS, policy.weights, strict=True)
            },
            "calibration": {
                "slope": round(policy.slope, 5),
                "intercept": round(policy.intercept, 5),
            },
            "min_confidence": policy.min_confidence,
            "min_margin": policy.min_margin,
            "min_agreement": policy.min_agreement,
            "provenance": {
                **provenance,
                "evidence_profile": "content",
                "out_of_fold": {
                    key: round(value, 4) if isinstance(value, float) else value
                    for key, value in metrics.items()
                },
            },
        },
        compact=False,
    )
    raw = {name: (out / name).read_bytes() for name in DATA_FILES}
    print(f"wrote {len(DATA_FILES)} data files, version {version_of(raw)}")


if __name__ == "__main__":
    main()
