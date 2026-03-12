import type { CSSProperties, ReactNode } from "react";
import { Button, Layout, Segmented, Spin } from "antd";
import { PlusOutlined } from "@ant-design/icons";

type LayoutMode = "vertical" | "horizontal";

type WorkspacePageLayoutProps = {
  headerStyle?: CSSProperties;
  layoutMode: LayoutMode;
  onLayoutModeChange: (mode: LayoutMode) => void;
  primaryActionLabel: string;
  primaryActionLoading?: boolean;
  primaryActionDisabled?: boolean;
  onPrimaryAction: () => void;
  secondaryActions?: ReactNode;
  rightActions?: ReactNode;
  loading: boolean;
  loadingTip?: string;
  children: ReactNode;
};

export default function WorkspacePageLayout(props: WorkspacePageLayoutProps) {
  const {
    headerStyle,
    layoutMode,
    onLayoutModeChange,
    primaryActionLabel,
    primaryActionLoading,
    primaryActionDisabled,
    onPrimaryAction,
    secondaryActions,
    rightActions,
    loading,
    loadingTip,
    children
  } = props;

  return (
    <>
      <Layout.Header className="topbar" style={headerStyle}>
        <div className="topbar-left">
          <Button
            type="primary"
            icon={<PlusOutlined />}
            loading={primaryActionLoading}
            disabled={primaryActionDisabled}
            onClick={onPrimaryAction}
          >
            {primaryActionLabel}
          </Button>
          {secondaryActions}
          <Segmented
            value={layoutMode}
            onChange={(value) => onLayoutModeChange(value === "horizontal" ? "horizontal" : "vertical")}
            options={[
              { value: "vertical", label: "竖屏" },
              { value: "horizontal", label: "横屏" }
            ]}
          />
        </div>
        <div className="topbar-right">{rightActions}</div>
      </Layout.Header>

      <Layout.Content className="app-content">
        {loading ? (
          <div className="loading-wrap">
            <Spin size="large" tip={loadingTip || "正在加载..."} />
          </div>
        ) : (
          children
        )}
      </Layout.Content>
    </>
  );
}
