import { Button, Card, Form, Input, Select, Space, Tag, Typography } from "antd";
import { FolderOpenOutlined } from "@ant-design/icons";

type CompanyModeRoleItem = {
  key: "commander" | "worker";
  name: string;
  description: string;
  terminalType: string;
  titlePreview: string;
  workDirectory: string;
  providerMode: "preset" | "custom";
  providerValue: string;
};

type CompanyModePageProps = {
  projectDirectory: string;
  codeDirectory: string;
  runtimeDirectory: string;
  commanderDirectory: string;
  workerDirectory: string;
  providers: string[];
  bootstrapping: boolean;
  generatedFiles: string[];
  roleItems: CompanyModeRoleItem[];
  onProjectDirectoryChange: (value: string) => void;
  onRoleProviderChange: (roleKey: "commander" | "worker", value: string) => void;
  onOpenRoleAdvanced: (roleKey: "commander" | "worker") => void;
  onPickProjectDirectory: () => void;
};

export default function CompanyModePage(props: CompanyModePageProps) {
  const {
    projectDirectory,
    codeDirectory,
    runtimeDirectory,
    commanderDirectory,
    workerDirectory,
    providers,
    bootstrapping,
    generatedFiles,
    roleItems,
    onProjectDirectoryChange,
    onRoleProviderChange,
    onOpenRoleAdvanced,
    onPickProjectDirectory,
  } = props;

  return (
    <div className="company-mode-page">
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <Card size="small">
          <Space direction="vertical" size={10} style={{ width: "100%" }}>
            <Space style={{ justifyContent: "space-between", width: "100%" }} wrap>
              <Space direction="vertical" size={2}>
                <Typography.Title level={4} style={{ margin: 0 }}>
                  {"\u4e00\u4e2a\u4eba\u7684\u516c\u53f8"}
                </Typography.Title>
                <Typography.Text type="secondary">
                  {"\u4f01\u4e1a\u6a21\u5f0f\u4e0e\u7ec8\u7aef\u914d\u7f6e\u5206\u79bb\u3002\u5173\u95ed\u540e\uff0c\u4e3b\u5de5\u4f5c\u533a\u4fdd\u6301\u73b0\u6709\u529f\u80fd\u4e0d\u53d8\u3002"}
                </Typography.Text>
              </Space>
              <Space>
              </Space>
            </Space>
          </Space>
        </Card>
        <Card size="small" title={"\u9879\u76ee\u76ee\u5f55"}>
          <Form layout="vertical">
            <Form.Item
              label={"\u9879\u76ee\u76ee\u5f55"}
              extra={"\u53ea\u9700\u9009\u62e9\u4e00\u6b21\u3002\u7cfb\u7edf\u4f1a\u81ea\u52a8\u7ef4\u62a4\u4ee3\u7801\u76ee\u5f55\u548c\u5de5\u4f5c\u76ee\u5f55\u3002"}
            >
              <Space.Compact style={{ width: "100%" }}>
                <Input
                  value={projectDirectory}
                  onChange={(event) => onProjectDirectoryChange(event.target.value)}
                  placeholder={"\u4f8b\u5982: D:/work/my-project"}
                />
                <Button icon={<FolderOpenOutlined />} onClick={onPickProjectDirectory}>
                  {"\u9009\u62e9\u76ee\u5f55"}
                </Button>
              </Space.Compact>
            </Form.Item>
            <Space direction="vertical" size={6} style={{ width: "100%" }}>
              <Typography.Text type="secondary">{"\u4ee3\u7801\u76ee\u5f55\uff1a"}{codeDirectory || "-"}</Typography.Text>
              <Typography.Text type="secondary">{"\u5de5\u4f5c\u6839\u76ee\u5f55\uff1a"}{runtimeDirectory || "-"}</Typography.Text>
              <Typography.Text type="secondary">{"\u6307\u6325\u76ee\u5f55\uff1a"}{commanderDirectory || "-"}</Typography.Text>
              <Typography.Text type="secondary">{"\u5de5\u4f5c\u76ee\u5f55\uff1a"}{workerDirectory || "-"}</Typography.Text>
            </Space>
          </Form>
        </Card>

        <Card size="small" title={"\u89d2\u8272\u5217\u8868"} extra={<Tag color="blue">{"\u9ad8\u7ea7\u9009\u9879\u4f7f\u7528\u5f39\u7a97"}</Tag>}>
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            {roleItems.map((role) => (
              <Card key={role.key} size="small">
                <Space direction="vertical" size={10} style={{ width: "100%" }}>
                  <Space style={{ justifyContent: "space-between", width: "100%" }} wrap>
                    <Space direction="vertical" size={2}>
                      <Space size={8}>
                        <Typography.Text strong>{role.name}</Typography.Text>
                        <Tag color={role.key === "commander" ? "purple" : "green"}>
                          {role.key === "commander" ? "\u6307\u6325" : "\u5de5\u4f5c"}
                        </Tag>
                        {role.providerMode === "custom" ? <Tag color="gold">{"\u81ea\u5b9a\u4e49 Provider"}</Tag> : null}
                      </Space>
                      <Typography.Text type="secondary">{role.description}</Typography.Text>
                    </Space>
                    <Button onClick={() => onOpenRoleAdvanced(role.key)}>{"\u9ad8\u7ea7\u9009\u9879"}</Button>
                  </Space>
                  <Space wrap style={{ width: "100%", justifyContent: "space-between" }}>
                    <Space direction="vertical" size={4} style={{ minWidth: 220 }}>
                      <Typography.Text type="secondary">{"\u7ec8\u7aef\u7c7b\u578b"}</Typography.Text>
                      <Select
                        value={role.providerValue}
                        onChange={(value) => onRoleProviderChange(role.key, String(value || providers[0] || "codex"))}
                        options={providers.map((item) => ({ value: item, label: item }))}
                        disabled={role.providerMode === "custom"}
                        style={{ width: 220 }}
                      />
                    </Space>
                    <Space direction="vertical" size={4} style={{ flex: 1, minWidth: 260 }}>
                      <Typography.Text type="secondary">{"\u6807\u9898\u9884\u89c8"}</Typography.Text>
                      <Typography.Text>{role.titlePreview}</Typography.Text>
                    </Space>
                  </Space>
                  <Typography.Text type="secondary">{"\u5de5\u4f5c\u76ee\u5f55\uff1a"}{role.workDirectory || "-"}</Typography.Text>
                  <Typography.Text type="secondary">{"\u7ec8\u7aef\u4f1a\u81ea\u52a8\u542f\u52a8\u5728\u8be5\u5de5\u4f5c\u76ee\u5f55\u3002"}</Typography.Text>
                </Space>
              </Card>
            ))}
          </Space>
        </Card>

        <Card size="small" title={"\u521d\u59cb\u5316\u7ed3\u679c"}>
          <Space direction="vertical" size={8} style={{ width: "100%" }}>
            <Typography.Text type="secondary">
              {"\u8fdb\u5165\u516c\u53f8\u6a21\u5f0f\u9875\u540e\uff0c\u7cfb\u7edf\u4f1a\u9ed8\u8ba4\u89c6\u4e3a\u5df2\u542f\u7528\u8be5\u6a21\u5f0f\u3002"}
            </Typography.Text>
            {generatedFiles.length ? (
              <>
                <Typography.Text type="secondary">{"\u5df2\u751f\u6210\u4ee5\u4e0b\u89c4\u5219\u6587\u4ef6\uff1a"}</Typography.Text>
                {generatedFiles.map((item) => (
                  <Typography.Text key={item} copyable>
                    {item}
                  </Typography.Text>
                ))}
              </>
            ) : (
              <Typography.Text type="secondary">
                {"\u521d\u59cb\u5316\u540e\u4f1a\u81ea\u52a8\u521b\u5efa\u6307\u6325\u7ec8\u7aef\u3001\u5de5\u4f5c\u7ec8\u7aef\uff0c\u4ee5\u53ca\u5bf9\u5e94\u89c4\u5219\u6587\u4ef6\u3002"}
              </Typography.Text>
            )}
          </Space>
        </Card>
      </Space>
    </div>
  );
}
