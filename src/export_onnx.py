"""scikit-learn HistGradientBoostingRegressor를 ONNX(TreeEnsembleRegressor)로 직접 변환한다.

skl2onnx 1.20의 변환기가 현재 scikit-learn/onnx 조합에서 오류를 내서
(`Expected an int, got a boolean`), 학습된 트리 구조를 읽어 ONNX 노드를 직접 만든다.
변환 뒤에는 `check_parity`로 원래 모델과 예측값이 같은지 반드시 확인한다.
"""

from __future__ import annotations

import numpy as np
import onnx
from onnx import TensorProto, helper


def hgb_to_onnx(model, n_features: int, input_name: str = "features", output_name: str = "prediction") -> onnx.ModelProto:
    """학습된 HistGradientBoostingRegressor → ONNX 모델(입력 [N, n_features] float32, 출력 [N, 1])."""
    tree_ids, node_ids, feature_ids, thresholds, modes = [], [], [], [], []
    true_ids, false_ids, missing_true = [], [], []
    leaf_tree_ids, leaf_node_ids, leaf_weights = [], [], []

    for tree_id, stage in enumerate(model._predictors):
        nodes = stage[0].nodes  # 회귀는 단계마다 트리 하나
        for node_id, node in enumerate(nodes):
            tree_ids.append(tree_id)
            node_ids.append(node_id)
            if node["is_leaf"]:
                modes.append("LEAF")
                feature_ids.append(0)
                thresholds.append(0.0)
                true_ids.append(0)
                false_ids.append(0)
                missing_true.append(0)
                leaf_tree_ids.append(tree_id)
                leaf_node_ids.append(node_id)
                leaf_weights.append(float(node["value"]))
            else:
                if node["is_categorical"]:
                    raise ValueError("범주형 분기는 지원하지 않는다")
                modes.append("BRANCH_LEQ")  # x <= 임계값이면 왼쪽(true) 자식으로
                feature_ids.append(int(node["feature_idx"]))
                thresholds.append(float(node["num_threshold"]))
                true_ids.append(int(node["left"]))
                false_ids.append(int(node["right"]))
                missing_true.append(int(bool(node["missing_go_to_left"])))

    ensemble = helper.make_node(
        "TreeEnsembleRegressor",
        inputs=[input_name],
        outputs=[output_name],
        domain="ai.onnx.ml",
        n_targets=1,
        aggregate_function="SUM",
        post_transform="NONE",
        base_values=[float(np.ravel(model._baseline_prediction)[0])],
        nodes_treeids=tree_ids,
        nodes_nodeids=node_ids,
        nodes_featureids=feature_ids,
        nodes_values=thresholds,
        nodes_modes=modes,
        nodes_truenodeids=true_ids,
        nodes_falsenodeids=false_ids,
        nodes_missing_value_tracks_true=missing_true,
        target_treeids=leaf_tree_ids,
        target_nodeids=leaf_node_ids,
        target_ids=[0] * len(leaf_weights),
        target_weights=leaf_weights,
    )
    graph = helper.make_graph(
        [ensemble],
        "pv_tomorrow_gbm",
        [helper.make_tensor_value_info(input_name, TensorProto.FLOAT, [None, n_features])],
        [helper.make_tensor_value_info(output_name, TensorProto.FLOAT, [None, 1])],
    )
    onnx_model = helper.make_model(
        graph,
        opset_imports=[helper.make_opsetid("", 17), helper.make_opsetid("ai.onnx.ml", 3)],
        producer_name="pv-tomorrow",
    )
    onnx_model.ir_version = 8  # 브라우저용 onnxruntime-web이 읽을 수 있는 버전으로 고정
    onnx.checker.check_model(onnx_model)
    return onnx_model


def check_parity(model, onnx_bytes: bytes, x: np.ndarray) -> float:
    """원래 모델과 ONNX 모델의 예측값 최대 차이를 돌려준다."""
    import onnxruntime as ort

    session = ort.InferenceSession(onnx_bytes, providers=["CPUExecutionProvider"])
    x32 = np.ascontiguousarray(x, dtype=np.float32)
    got = session.run(None, {session.get_inputs()[0].name: x32})[0].ravel()
    return float(np.abs(got - model.predict(x32)).max())
