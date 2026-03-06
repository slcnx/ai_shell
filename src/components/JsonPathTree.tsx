import { Tree, Typography } from "antd";
import type { DataNode } from "antd/es/tree";
import { useMemo } from "react";

export type JsonPathToken = string | number;

type JsonPathTreeProps = {
  value: unknown;
  maxExpandDepth?: number;
  onSelectPath: (path: JsonPathToken[], value: unknown) => void;
};

type JsonTreeNode = DataNode & {
  path_tokens: JsonPathToken[];
  node_value: unknown;
};

function previewPrimitive(value: unknown): string {
  if (typeof value === "string") {
    const compact = value.replace(/\s+/g, " ").trim();
    if (!compact.length) {
      return '""';
    }
    if (compact.length > 96) {
      return `"${compact.slice(0, 96)}..."`;
    }
    return `"${compact}"`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  return "";
}

function nodeTypeText(value: unknown): string {
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }
  if (value && typeof value === "object") {
    return "object";
  }
  return typeof value;
}

function buildJsonTree(
  keyLabel: string,
  value: unknown,
  pathTokens: JsonPathToken[],
  depth: number,
  maxExpandDepth: number,
  expandedKeys: string[]
): JsonTreeNode {
  const key = pathTokens.length ? pathTokens.join(".") : "__root__";
  const typeText = nodeTypeText(value);
  const primitive = previewPrimitive(value);
  const isContainer = Array.isArray(value) || (value !== null && typeof value === "object");
  const title = (
    <span className="json-path-node-title">
      <Typography.Text code className="json-path-node-key">
        {keyLabel}
      </Typography.Text>
      <Typography.Text type="secondary" className="json-path-node-type">
        {typeText}
      </Typography.Text>
      {primitive ? (
        <Typography.Text className="json-path-node-value">{primitive}</Typography.Text>
      ) : null}
    </span>
  );

  const node: JsonTreeNode = {
    key,
    title,
    path_tokens: pathTokens,
    node_value: value,
    selectable: true
  };

  if (!isContainer) {
    node.isLeaf = true;
    return node;
  }

  if (depth <= maxExpandDepth) {
    expandedKeys.push(key);
  }

  if (Array.isArray(value)) {
    node.children = value.map((item, index) =>
      buildJsonTree(`[${index}]`, item, [...pathTokens, index], depth + 1, maxExpandDepth, expandedKeys)
    );
    return node;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  node.children = entries.map(([childKey, childValue]) =>
    buildJsonTree(childKey, childValue, [...pathTokens, childKey], depth + 1, maxExpandDepth, expandedKeys)
  );
  return node;
}

function JsonPathTree({ value, maxExpandDepth = 2, onSelectPath }: JsonPathTreeProps) {
  const { treeData, expandedKeys } = useMemo(() => {
    const nextExpanded: string[] = [];
    const root = buildJsonTree("root", value, [], 0, maxExpandDepth, nextExpanded);
    return {
      treeData: [root] as DataNode[],
      expandedKeys: nextExpanded
    };
  }, [maxExpandDepth, value]);

  return (
    <div className="json-path-tree">
      <Tree
        blockNode
        treeData={treeData}
        defaultExpandedKeys={expandedKeys}
        onSelect={(_, info) => {
          const node = info.node as unknown as JsonTreeNode;
          onSelectPath(node.path_tokens || [], node.node_value);
        }}
      />
    </div>
  );
}

export default JsonPathTree;
