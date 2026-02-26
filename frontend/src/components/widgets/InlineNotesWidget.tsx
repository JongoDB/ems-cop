import { useEffect, useRef, useCallback } from 'react'
import { WidgetProps } from './WidgetRegistry'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'

interface ToolbarBtnProps {
  label: string
  active: boolean
  onClick: () => void
}

function ToolbarBtn({ label, active, onClick }: ToolbarBtnProps) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? 'var(--color-accent)' : 'var(--color-bg-elevated)',
        color: active ? '#fff' : 'var(--color-text-muted)',
        border: '1px solid var(--color-border)',
        borderRadius: '3px',
        padding: '2px 7px',
        fontSize: '10px',
        fontWeight: 600,
        cursor: 'pointer',
        lineHeight: '16px',
        minWidth: '24px',
      }}
    >
      {label}
    </button>
  )
}

export default function InlineNotesWidget({ id, config, onConfigChange }: WidgetProps) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const configRef = useRef(config)
  configRef.current = config

  const onConfigChangeRef = useRef(onConfigChange)
  onConfigChangeRef.current = onConfigChange

  const handleUpdate = useCallback(
    ({ editor: ed }: { editor: ReturnType<typeof useEditor> extends infer E ? NonNullable<E> : never }) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        const json = ed.getJSON()
        onConfigChangeRef.current?.({ ...configRef.current, content: json })
      }, 1000)
    },
    [],
  )

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
    ],
    content: (config.content as Record<string, unknown>) || '<p></p>',
    onUpdate: handleUpdate,
    editorProps: {
      attributes: {
        class: 'ems-notes-editor',
        style: [
          'outline: none',
          'height: 100%',
          'overflow-y: auto',
          'padding: 8px 10px',
          'font-family: var(--font-sans)',
          'font-size: 12px',
          'color: var(--color-text-primary)',
          'line-height: 1.5',
        ].join('; '),
      },
    },
  })

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const containerStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    fontFamily: 'var(--font-sans)',
    fontSize: '11px',
    color: 'var(--color-text-primary)',
    background: 'var(--color-bg-primary)',
    overflow: 'hidden',
  }

  const toolbarStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '3px',
    padding: '4px 8px',
    borderBottom: '1px solid var(--color-border)',
    flexShrink: 0,
    flexWrap: 'wrap',
  }

  const editorContainerStyle: React.CSSProperties = {
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
  }

  return (
    <div data-widget-id={id} style={containerStyle}>
      <div style={toolbarStyle}>
        <ToolbarBtn
          label="B"
          active={editor?.isActive('bold') ?? false}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        />
        <ToolbarBtn
          label="I"
          active={editor?.isActive('italic') ?? false}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        />
        <div style={{ width: '1px', height: '16px', background: 'var(--color-border)', margin: '0 2px' }} />
        <ToolbarBtn
          label="H1"
          active={editor?.isActive('heading', { level: 1 }) ?? false}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
        />
        <ToolbarBtn
          label="H2"
          active={editor?.isActive('heading', { level: 2 }) ?? false}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
        />
        <div style={{ width: '1px', height: '16px', background: 'var(--color-border)', margin: '0 2px' }} />
        <ToolbarBtn
          label="List"
          active={editor?.isActive('bulletList') ?? false}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        />
        <ToolbarBtn
          label="Code"
          active={editor?.isActive('codeBlock') ?? false}
          onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
        />
        <ToolbarBtn
          label="Quote"
          active={editor?.isActive('blockquote') ?? false}
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
        />
      </div>
      <div style={editorContainerStyle}>
        <style>{`
          .ems-notes-editor {
            flex: 1;
            min-height: 0;
          }
          .ems-notes-editor h1 {
            font-size: 18px;
            font-weight: 700;
            margin: 8px 0 4px;
            color: var(--color-text-primary);
          }
          .ems-notes-editor h2 {
            font-size: 15px;
            font-weight: 600;
            margin: 6px 0 3px;
            color: var(--color-text-primary);
          }
          .ems-notes-editor h3 {
            font-size: 13px;
            font-weight: 600;
            margin: 4px 0 2px;
            color: var(--color-text-primary);
          }
          .ems-notes-editor p {
            margin: 2px 0;
          }
          .ems-notes-editor ul, .ems-notes-editor ol {
            padding-left: 20px;
            margin: 2px 0;
          }
          .ems-notes-editor li {
            margin: 1px 0;
          }
          .ems-notes-editor code {
            background: var(--color-bg-elevated);
            border-radius: 3px;
            padding: 1px 4px;
            font-family: var(--font-mono);
            font-size: 11px;
          }
          .ems-notes-editor pre {
            background: var(--color-bg-elevated);
            border-radius: 4px;
            padding: 8px 10px;
            margin: 4px 0;
            overflow-x: auto;
          }
          .ems-notes-editor pre code {
            background: none;
            padding: 0;
            font-family: var(--font-mono);
            font-size: 11px;
            color: var(--color-text-primary);
          }
          .ems-notes-editor blockquote {
            border-left: 3px solid var(--color-accent);
            padding-left: 10px;
            margin: 4px 0;
            color: var(--color-text-muted);
          }
          .ems-notes-editor p.is-editor-empty:first-child::before {
            content: 'Add notes...';
            color: var(--color-text-muted);
            float: left;
            pointer-events: none;
            height: 0;
          }
          .ProseMirror {
            height: 100%;
            overflow-y: auto;
          }
          .ProseMirror:focus {
            outline: none;
          }
        `}</style>
        <EditorContent
          editor={editor}
          style={{ flex: 1, minHeight: 0, overflow: 'auto' }}
        />
      </div>
    </div>
  )
}
