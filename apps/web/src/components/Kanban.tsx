import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { STATUSES, type Status } from '@jm/shared';
import type { ApplicationRow } from '../api.ts';
import { FitBadge, FlagChips, jobFlags } from './badges.tsx';
import { cx } from './ui.tsx';

/** Dead-end statuses: collapsed into slim drop targets unless expanded. Offer stays a full column. */
const ENDED: Status[] = ['Rejected', 'Withdrawn', 'Ghosted'];
const PIPELINE = STATUSES.filter((s) => !ENDED.includes(s));
const KEY = 'jm-kanban-show-closed';

export function Kanban({
  rows,
  onMove,
}: {
  rows: ApplicationRow[];
  onMove: (id: number, status: Status) => void;
}) {
  const [showClosed, setShowClosed] = useState(() => {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setShowClosed((v) => {
      try {
        localStorage.setItem(KEY, v ? '0' : '1');
      } catch {
        // not persisted
      }
      return !v;
    });

  // A small drag distance keeps plain clicks working as links.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragEnd = (e: DragEndEvent) => {
    const id = Number(e.active.id);
    const to = e.over?.id as Status | undefined;
    const row = rows.find((r) => r.id === id);
    if (row && to && row.status !== to) onMove(id, to);
  };
  const closedCount = rows.filter((r) => ENDED.includes(r.status)).length;

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="flex gap-3 overflow-x-auto pb-4">
        {PIPELINE.map((s) => (
          <Column key={s} status={s} rows={rows.filter((r) => r.status === s)} />
        ))}
        {showClosed ? (
          <>
            {ENDED.map((s) => (
              <Column key={s} status={s} rows={rows.filter((r) => r.status === s)} muted />
            ))}
            <button
              onClick={toggle}
              className="shrink-0 self-start rounded-md px-2 py-1.5 text-xs text-ink-3 hover:text-ink"
            >
              Hide closed
            </button>
          </>
        ) : (
          <div className="flex w-28 shrink-0 flex-col gap-2">
            <button
              onClick={toggle}
              className="rounded-md px-2 py-1.5 text-left text-xs font-semibold text-ink-2 hover:text-ink"
              title="Show closed applications"
            >
              Closed <span className="font-normal text-ink-3">{closedCount}</span> ›
            </button>
            {ENDED.map((s) => (
              <DropSlot key={s} status={s} count={rows.filter((r) => r.status === s).length} />
            ))}
          </div>
        )}
      </div>
    </DndContext>
  );
}

function Column({
  status,
  rows,
  muted,
}: {
  status: Status;
  rows: ApplicationRow[];
  muted?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <div
      ref={setNodeRef}
      className={cx(
        'flex w-60 shrink-0 flex-col rounded-lg border border-border bg-surface-2/60',
        muted && 'opacity-80',
        isOver && 'ring-2 ring-accent/50',
      )}
    >
      <div className="flex items-center justify-between px-3 py-2 text-xs font-semibold text-ink-2">
        <span>{status}</span>
        <span className="tabular-nums text-ink-3">{rows.length}</span>
      </div>
      <div className="flex min-h-24 flex-col gap-2 px-2 pb-2">
        {rows.map((r) => (
          <CardItem key={r.id} row={r} />
        ))}
      </div>
    </div>
  );
}

/** Compact drop target for a closed status when those columns are collapsed. */
function DropSlot({ status, count }: { status: Status; count: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <div
      ref={setNodeRef}
      className={cx(
        'flex h-16 items-center justify-between rounded-lg border border-dashed border-border px-2.5 text-xs text-ink-3',
        isOver && 'border-accent bg-surface-2 text-ink',
      )}
    >
      <span>{status}</span>
      <span className="tabular-nums">{count}</span>
    </div>
  );
}

function CardItem({ row }: { row: ApplicationRow }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: row.id });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : undefined}
      className={cx(
        'cursor-grab rounded-md border border-border bg-surface p-2.5 text-sm shadow-sm',
        isDragging && 'relative z-50 cursor-grabbing shadow-lg',
      )}
    >
      <Link
        to={`/applications/${row.id}`}
        className="block font-medium leading-snug hover:underline"
      >
        {row.title}
      </Link>
      <div className="mt-0.5 text-xs text-ink-2">{row.company}</div>
      <div className="mt-1">
        <FlagChips flags={jobFlags(row)} />
      </div>
      <div className="mt-2 flex items-center justify-between text-xs">
        <FitBadge score={row.fitScore} gate={row.fitGate} reasons={row.fitGateReasons} compact />
        {row.nextActionDate && <span className="text-ink-3">Next: {row.nextActionDate}</span>}
      </div>
    </div>
  );
}
