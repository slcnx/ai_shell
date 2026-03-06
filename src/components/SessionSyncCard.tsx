import { EyeOutlined } from "@ant-design/icons";
import { Button, Card, Checkbox, Space, Tag, Typography } from "antd";

export type SessionSyncCardStats = {
  all_count: number;
  scoped_count: number;
  filtered_count: number;
  excluded_count: number;
  pending_count: number;
  updated_text: string;
};

type SessionSyncCardProps = {
  sid: string;
  sid_short: string;
  role_label: string;
  role_color?: string;
  selected: boolean;
  previewing: boolean;
  stats: SessionSyncCardStats;
  on_toggle_selected: (checked: boolean) => void;
  on_preview: () => void;
  on_exclude_group: () => void;
  on_restore_group: () => void;
  exclude_disabled?: boolean;
  restore_disabled?: boolean;
  created_text?: string;
  updated_text?: string;
  record_count?: number;
};

function SessionSyncCard({
  sid,
  sid_short,
  role_label,
  role_color,
  selected,
  previewing,
  stats,
  on_toggle_selected,
  on_preview,
  on_exclude_group,
  on_restore_group,
  exclude_disabled,
  restore_disabled,
  created_text,
  updated_text,
  record_count
}: SessionSyncCardProps) {
  const createdText = created_text || "-";
  const updatedText = updated_text || stats.updated_text;
  const recordCount = Number.isFinite(record_count) ? Number(record_count) : stats.all_count;
  return (
    <Card
      size="small"
      hoverable
      onClick={() => on_preview()}
      className={`sync-session-item-card ${selected ? "selected" : "unselected"} ${
        previewing ? "previewing" : ""
      }`}
    >
      <div className="sync-session-item-head">
        <Space size={6} wrap>
          <Checkbox
            checked={selected}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => on_toggle_selected(Boolean(event.target.checked))}
          />
          <Tag color={role_color}>{role_label}</Tag>
          <Typography.Text code>{sid_short}</Typography.Text>
          <Typography.Text copyable={{ text: sid }} type="secondary">
            复制 SID
          </Typography.Text>
        </Space>
        <Space size={6}>
          <Button
            size="small"
            type={previewing ? "primary" : "default"}
            icon={<EyeOutlined />}
            onClick={(event) => {
              event.stopPropagation();
              on_preview();
            }}
          >
            {previewing ? "预览中" : "预览"}
          </Button>
          <Button
            size="small"
            onClick={(event) => {
              event.stopPropagation();
              on_exclude_group();
            }}
            disabled={exclude_disabled}
          >
            排除本组
          </Button>
          <Button
            size="small"
            type="primary"
            onClick={(event) => {
              event.stopPropagation();
              on_restore_group();
            }}
            disabled={restore_disabled}
          >
            恢复本组
          </Button>
        </Space>
      </div>
      <Space size={6} wrap>
        <Tag>创建 {createdText}</Tag>
        <Tag>更新 {updatedText}</Tag>
        <Tag color="cyan">记录数 {recordCount}</Tag>
        <Tag>总记录 {stats.all_count}</Tag>
        <Tag color="blue">策略 {stats.scoped_count}</Tag>
        <Tag>筛后 {stats.filtered_count}</Tag>
        <Tag color="warning">取消 {stats.excluded_count}</Tag>
        <Tag color={stats.pending_count > 0 ? "success" : "default"}>待同步 {stats.pending_count}</Tag>
      </Space>
    </Card>
  );
}

export default SessionSyncCard;
