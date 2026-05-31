// ============================================
// AI CODE STUDIO - MONACO EDITOR COMPONENT
// ============================================

import { useRef, useEffect, useCallback } from 'react';
import Editor, { OnMount, OnChange } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { useEditorStore, useUIStore } from '../../stores/useStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { simulateCompletion } from '../../services/mockBackend';
import { getCodeCompletion } from '../../services/aiAdapter';

interface MonacoEditorProps {
  fileId: string;
  content: string;
  language: string;
  onChange: (content: string) => void;
}

export function MonacoEditor({ fileId, content, language, onChange }: MonacoEditorProps) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const { cursors, collabUsers } = useEditorStore();
  const { theme } = useUIStore();
  const decorationsRef = useRef<string[]>([]);
  const completionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    // Configure editor options
    editor.updateOptions({
      fontSize: 14,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontLigatures: true,
      minimap: { enabled: true, scale: 1 },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      renderLineHighlight: 'all',
      bracketPairColorization: { enabled: true },
      autoClosingBrackets: 'always',
      autoClosingQuotes: 'always',
      formatOnPaste: true,
      formatOnType: true,
      tabSize: 2,
      wordWrap: 'on',
      padding: { top: 16 },
    });

    // Add keyboard shortcuts
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      // Save file
      console.log('Save triggered');
    });

    // Register inline completion provider
    monaco.languages.registerInlineCompletionsProvider(language, {
      provideInlineCompletions: async (model: any, position: any) => {
        const settings = useSettingsStore.getState();
        if (!settings.autoComplete) {
          return { items: [] };
        }

        const textUntilPosition = model.getValueInRange({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });

        const textAfterPosition = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: model.getLineCount(),
          endColumn: model.getLineMaxColumn(model.getLineCount()),
        });

        // Get AI completion
        try {
          let completion = '';
          if (settings.demoMode) {
            completion = await simulateCompletion(
              textUntilPosition.slice(-500),
              textAfterPosition.slice(0, 100),
              language
            );
          } else {
            completion = await getCodeCompletion(
              textUntilPosition.slice(-1000),
              textAfterPosition.slice(0, 500),
              language
            );
          }

          if (completion) {
            return {
              items: [{
                insertText: completion,
                range: {
                  startLineNumber: position.lineNumber,
                  startColumn: position.column,
                  endLineNumber: position.lineNumber,
                  endColumn: position.column,
                },
              }],
            };
          }
        } catch (e) {
          console.error('Completion error:', e);
        }

        return { items: [] };
      },
      freeInlineCompletions: () => {},
    });
  };

  const handleChange: OnChange = useCallback((value) => {
    if (value !== undefined) {
      onChange(value);
    }
  }, [onChange]);

  // Update cursor decorations from collaborators
  useEffect(() => {
    if (!editorRef.current || !monacoRef.current) return;

    const editor = editorRef.current;
    const monaco = monacoRef.current;

    // Remove old decorations
    decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);

    // Add new cursor decorations
    const newDecorations: Monaco.editor.IModelDeltaDecoration[] = [];

    cursors
      .filter(c => c.id !== fileId)
      .forEach(cursor => {
        // Cursor line decoration
        newDecorations.push({
          range: new monaco.Range(
            cursor.position.line,
            cursor.position.column,
            cursor.position.line,
            cursor.position.column + 1
          ),
          options: {
            className: `cursor-${cursor.userId}`,
            beforeContentClassName: 'cursor-marker',
            hoverMessage: { value: cursor.userName },
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        });

        // Selection decoration
        if (cursor.selection) {
          newDecorations.push({
            range: new monaco.Range(
              cursor.selection.startLine,
              cursor.selection.startColumn,
              cursor.selection.endLine,
              cursor.selection.endColumn
            ),
            options: {
              className: `selection-${cursor.userId}`,
              inlineClassName: 'collab-selection',
            },
          });
        }
      });

    decorationsRef.current = editor.deltaDecorations([], newDecorations);
  }, [cursors, collabUsers, fileId]);

  // Cleanup
  useEffect(() => {
    return () => {
      if (completionTimeoutRef.current) {
        clearTimeout(completionTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div className="h-full w-full">
      <Editor
        height="100%"
        language={language}
        value={content}
        theme={theme === 'dark' ? 'vs-dark' : 'light'}
        onChange={handleChange}
        onMount={handleEditorDidMount}
        loading={
          <div className="flex items-center justify-center h-full bg-gray-900">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
          </div>
        }
        options={{
          automaticLayout: true,
        }}
      />
    </div>
  );
}
