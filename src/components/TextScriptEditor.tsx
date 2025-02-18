import { Editor, Monaco } from '@monaco-editor/react'
import { MODDIOSCRIPT } from '../constants/string'
import { languageDef, configuration, OPTIONS, FUNC } from '../constants/monacoConfig'
import React, { useEffect, useRef, useState } from 'react'
import { IDisposable, editor, languages } from 'monaco-editor'
import { aliasTable, parser, actionToString, noBracketsFuncs } from 'script-parser'
import { checkSuggestions, getSuggestionType, checkIsWrappedInQuotes, checkTypeIsValid, findFunctionPos, getActions, getInputProps, getFunctionProps, postProcessOutput } from '../utils/actions'
import { findString } from '../utils/string'



export interface TextScriptErrorProps {
  hash: {
    text: string,
    token: string,
    line: number,
    loc: {
      first_line: number,
      last_line: number,
      first_column: number,
      last_column: number
    },
    expected: string[],
    recoverable: boolean
  }
}
export interface ExtraDataProps { thisEntity: { dataType: string, entity: string, key: string }[] }
interface TextScriptEditorProps {
  debug: boolean,
  idx: number,
  defaultValue?: string,
  defaultReturnType?: string,
  extraSuggestions?: Record<string, languages.CompletionItem[]>,
  extraData?: ExtraDataProps,
  onError?: ({ e, output }: { e: string[], output: string | undefined }) => void,
  onSuccess?: (parserOutput: string | undefined) => void,
}

export const triggerCharacters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.\\@".split("");
export const triggerCharactersWithNumber = triggerCharacters.concat("1234567890-+*/".split(""));

export interface FunctionProps {
  functionName: string,
  functionParametersOffset: number
}


const TextScriptEditor: React.FC<TextScriptEditorProps> = ({ idx, onSuccess, onError, extraData, extraSuggestions, debug = false, defaultValue = '', defaultReturnType = '' }) => {
  const [parseStr, setParseStr] = useState<string | object>('')
  const [convertedStr, setConvertedStr] = useState('')
  const editorRef = useRef<editor.IStandaloneCodeEditor | undefined>(undefined);
  const monacoRef = useRef<Monaco | undefined>(undefined)
  const disposableRef = useRef<IDisposable[]>([])
  const stringToAction = (v?: string) => {
    if (v === '') {
      onSuccess?.(undefined)
      setParseStr('')
      setConvertedStr('')
      monacoRef.current!.editor.setModelMarkers(editorRef.current!.getModel()!, 'owner', [])
    } else {
      try {
        let value = v
        extraSuggestions?.[defaultReturnType || '_']?.forEach((suggest) => {
          if (value) {
            switch (defaultReturnType) {
              case 'unitType': {
                value = value.replaceAll(new RegExp(`\\b${suggest.insertText}\\b(?![^"]*")`, 'g'), `"${suggest.detail}"`)
                break;
              }
              case 'script': {
                value = value.replaceAll(new RegExp(`\\b${suggest.insertText}\\b(?![^"]*")`, 'g'), `"${suggest.detail}"`)
                break;
              }
            }
          }
        })
        const output = parser.parse(value || '')
        const processedOutput = typeof output === 'object' ? postProcessOutput(output, extraData) : output
        setParseStr(processedOutput)
        // TODO: add gameData
        setConvertedStr(actionToString({
          o: processedOutput, parentKey: '', defaultReturnType: defaultReturnType || '', gameData: { unitTypes: {} }
        }))
        monacoRef.current!.editor.setModelMarkers(editorRef.current!.getModel()!, 'owner', [])
        if (typeof output === 'object') {
          const errors = checkTypeIsValid(value || '', output, defaultReturnType)
          if (errors.length === 0) {
            onSuccess?.(processedOutput)
          } else {
            onError?.({ e: errors.map((error) => error.message), output: processedOutput })
            monacoRef.current!.editor.setModelMarkers(editorRef.current!.getModel()!, 'owner', errors)
          }
        } else {
          if (defaultReturnType !== undefined && defaultReturnType !== '' && typeof output !== defaultReturnType && !(typeof output === 'string' && defaultReturnType?.includes('Type'))
            && !(typeof output === 'string' && defaultReturnType === 'script')
          ) {
            const message = `expect ${defaultReturnType} here, but got ${typeof output}`
            onError?.({ e: [message], output: undefined })
            monacoRef.current!.editor.setModelMarkers(editorRef.current!.getModel()!, 'owner', [{
              message,
              severity: 8,
              startLineNumber: 0,
              startColumn: 0,
              endLineNumber: 0,
              endColumn: value?.length || 0,
            }])
          } else {
            onSuccess?.(processedOutput)
            monacoRef.current!.editor.setModelMarkers(editorRef.current!.getModel()!, 'owner', [])
          }
        }
      } catch (e: any) {
        const error: TextScriptErrorProps | Error = e
        setParseStr(e)
        if (editorRef.current && monacoRef.current) {
          const monaco = monacoRef.current
          const editor = editorRef.current
          const model = editor.getModel()
          if (model) {
            const markers: editor.IMarkerData[] = []
            const errorHash = (error as TextScriptErrorProps).hash
            if (errorHash) {
              if (errorHash.expected) {
                const message = `expect ${errorHash.expected?.join(', ')} here, but got ${errorHash.token}`
                onError?.({ e: [message], output: undefined })
                markers.push({
                  message,
                  severity: monaco.MarkerSeverity.Error,
                  startLineNumber: errorHash.loc.first_line,
                  startColumn: errorHash.loc.first_column,
                  endLineNumber: errorHash.loc.last_line,
                  endColumn: errorHash.loc.last_column,
                });
              }
            } else {
              const code = model.getValue();
              const undefinedName = code.replace(' is undefined', '')
              const { startColumn, endColumn } = findFunctionPos(code, undefinedName)
              onError?.({ e: [e.message as string], output: undefined })
              markers.push({
                message: e.message as string,
                severity: monaco.MarkerSeverity.Error,
                startLineNumber: 0,
                startColumn,
                endLineNumber: 0,
                endColumn,
              }
              )
            }
            monaco.editor.setModelMarkers(model, 'owner', markers)
          }
        }
      }
    }
  }

  const init = (monaco: Monaco) => {
    // Register a tokens provider for the language
    disposableRef.current.push(monaco.languages.setMonarchTokensProvider(MODDIOSCRIPT + idx, languageDef))
    // Set the editing configuration for the language
    disposableRef.current.push(monaco.languages.setLanguageConfiguration(MODDIOSCRIPT + idx, configuration))
    disposableRef.current.push(monaco.languages.registerCompletionItemProvider(MODDIOSCRIPT + idx, {
      triggerCharacters,
      provideCompletionItems: (model, position, context, token) => {
        let word = model.getWordUntilPosition(position);
        let range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        let cursorPos = model.getOffsetAt(position);
        const code = model.getValue();
        const suggestionType = getSuggestionType(code, Math.max(0, cursorPos - 1))
        const needBrackets = (obj: any) => suggestionType === FUNC && !noBracketsFuncs.includes(obj.key)
        const inputProps = getInputProps(getFunctionProps(code, Math.max(0, cursorPos - 1)))
        const suggestions: languages.CompletionItem[] = checkIsWrappedInQuotes(code, Math.max(0, cursorPos - 1)) ? [] :
          getActions().map((obj, orderIdx) => ({
            label: `${aliasTable[obj.key] ?? obj.key}${needBrackets(obj) ? '(' : ''}${suggestionType === FUNC ? obj.data.fragments.filter((v: any) => v.type === 'variable').map((v: any, idx: number) => {
              return `${v.field}:${v.dataType}`
            }).join(', ') : ''}${needBrackets(obj) ? ')' : ''}: ${obj.data.category}`,
            kind: suggestionType === FUNC ? monaco.languages.CompletionItemKind.Function : monaco.languages.CompletionItemKind.Property,
            insertText: `${aliasTable[obj.key] ?? obj.key}${needBrackets(obj) ? '(' : ''}${suggestionType === FUNC ? obj.data.fragments.filter((v: any) => v.type === 'variable').map((v: any, idx: number) => {
              return `\${${idx + 1}:${v.field}}`
            }).join(', ') : ''}${needBrackets(obj) ? ')' : ''}`,
            // TODO: add documentation
            sortText: checkSuggestions(obj, inputProps, defaultReturnType),
            documentation: (obj as any).data.fragments.filter((v: any) => v.type === 'constant')[0]?.text,
            insertTextRules: 4,
            detail: obj.title,
            range,
          }))
        const extra: languages.CompletionItem[] = []
        if (extraSuggestions) {
          Object.keys(extraSuggestions)?.forEach((key) => {
            if (getFunctionProps(code, Math.max(0, cursorPos - 1)).functionName === key || key === defaultReturnType) {
              extraSuggestions[key].forEach((suggestion) => {
                suggestion.range = range
                extra.push(suggestion)
              })
            }
          })
        }

        return {
          incomplete: true,
          suggestions: extraSuggestions ? extra.concat(suggestions) : suggestions,
        }
      },
    }))
    // TODO: finish hover provider
    // monaco.languages.registerHoverProvider(MODDIOSCRIPT, {
    //   provideHover: (model, position, token) => {
    //     const { column, lineNumber } = position;

    //     const word = model.getWordAtPosition(position)?.word
    //     const contents = model.getLineContent(lineNumber)
    //     console.log(model, position, token, word, contents)
    //     return {
    //       value: 'hello?' || '',
    //       isTrusted: true,
    //       supportThemeIcons: true,
    //       contents: [{
    //         value: 'hello!',
    //       }]
    //     }
    //   }
    // })
    // TODO: finish signatureHelp provider
    disposableRef.current.push(monaco.languages.registerSignatureHelpProvider(MODDIOSCRIPT + idx, {
      signatureHelpTriggerCharacters: triggerCharactersWithNumber,
      provideSignatureHelp: async (model, position, token, context) => {
        const code = model.getValue();
        let cursorPos = model.getOffsetAt(position);
        const functionProps = getFunctionProps(code, Math.max(0, cursorPos - 1))
        const targetAction = getActions().find((obj) => (aliasTable[obj.key] ?? obj.key) === functionProps.functionName)
        const targetFrag: any = targetAction?.data.fragments.filter((frag: any) => frag.type === 'variable')
        const signatures: languages.SignatureHelp['signatures'] = !targetAction || functionProps.functionName === 'undefined' ? [] :
          [
            {
              label: '',
              documentation: {
                value:
                  `${functionProps.functionName}(${targetFrag?.map((frag: any, idx: number) => (`${idx === functionProps.functionParametersOffset ? '**' : ''}${frag.field}: ${frag.extraData?.dataType || frag.dataType}${idx === functionProps.functionParametersOffset ? '**' : ''}`))})`,
              },

              parameters:
                targetFrag.map((frag: any) => ({
                  label: "",
                  documentation: frag.filed
                }))
            },
          ];

        return {
          dispose: () => { },
          value: {
            activeParameter: functionProps.functionParametersOffset,
            activeSignature: 0,
            signatures,
          },
        };
      }
    }))
  }

  useEffect(() => {
    if (monacoRef.current) {
      disposableRef.current.forEach((ref) => {
        ref.dispose()
      })
      init(monacoRef.current)
    }

  }, [defaultReturnType, extraSuggestions])

  useEffect(() => {
    return () => {
      disposableRef.current.forEach((ref) => {
        ref.dispose()
      })
    }
  }, [])

  return (
    <>
      <Editor
        language={MODDIOSCRIPT + idx}
        height="1.5rem"
        theme="vs-dark"
        options={OPTIONS}
        beforeMount={(monaco) => {
          monacoRef.current = monaco
          // Register a new language
          monaco.languages.register({ id: MODDIOSCRIPT + idx })
          init(monaco)
        }}
        onMount={editor => {
          editorRef.current = editor

          // detect tab click
          editor.onKeyDown((e) => {
            if (e.keyCode === 2) {
              e.stopPropagation();
            }
          });

          editor.setValue(defaultValue)
          stringToAction(defaultValue)
          //@ts-ignore, the type define is wrong, editor have onDidType
          editor.onDidType((v) => {
            editor.trigger('anything', 'editor.action.triggerParameterHints', () => { })
          })

          editor.onKeyDown(e => {
            if (e.code === "Enter") {
              editor.trigger('anything', 'acceptSelectedSuggestion', () => { })
            }
          })
          // disable `Find` widget
          // see: https://github.com/microsoft/monaco-editor/issues/287#issuecomment-328371787
          editor.addCommand(monacoRef.current!.KeyMod.CtrlCmd | monacoRef.current!.KeyCode.KeyF, () => { })
          editor.addCommand(monacoRef.current!.KeyMod.CtrlCmd | monacoRef.current!.KeyCode.KeyH, () => { })

          // disable press `Enter` in case of producing line breaks
          editor.addCommand(monacoRef.current!.KeyCode.Enter, () => {
            // State: https://github.com/microsoft/vscode/blob/1.56.0/src/vs/editor/contrib/suggest/suggestWidget.ts#L50

            /**
             * Origin purpose: disable line breaks
             * Side Effect: If defining completions, will prevent `Enter` confirm selection
             * Side Effect Solution: always accept selected suggestion when `Enter`
             *
             * But it is hard to find out the name `acceptSelectedSuggestion` to trigger.
             *
             * Where to find the `acceptSelectedSuggestion` at monaco official documents ?
             * Below is some refs:
             * - https://stackoverflow.com/questions/64430041/get-a-list-of-monaco-commands-actions-ids
             * - command from: https://github.com/microsoft/vscode/blob/e216a598d3e02401f26459fb63a4f1b6365ec4ec/src/vs/editor/contrib/suggest/suggestController.ts#L632-L638
             * - https://github.com/microsoft/vscode/search?q=registerEditorCommand
             * - real list: https://github.com/microsoft/vscode/blob/e216a598d3e02401f26459fb63a4f1b6365ec4ec/src/vs/editor/browser/editorExtensions.ts#L611
             *
             *
             * Finally, `acceptSelectedSuggestion` appears here:
             * - `editorExtensions.js` Line 288
             */
            editor.trigger('anything', 'acceptSelectedSuggestion', () => { })
          })

          // deal with user paste
          // see: https://github.com/microsoft/monaco-editor/issues/2009#issue-63987720
          editor.onDidPaste((e) => {
            // multiple rows will be merged to single row
            if (e.range.endLineNumber <= 1) {
              return
            }
            let newContent = ''
            const textModel = editor.getModel() as editor.ITextModel
            const lineCount = textModel.getLineCount()
            // remove all line breaks
            for (let i = 0; i < lineCount; i += 1) {
              newContent += `${textModel.getLineContent(i + 1)}${i !== lineCount - 1 ? ' ' : ''}`
            }
            textModel.setValue(newContent)
            editor.setPosition({ column: newContent.length + 2, lineNumber: 1 })
          })

          // disable `F1` command palette
          editor.addCommand(monacoRef.current!.KeyCode.F1, () => { })
          // disable `SHIFT+ENTER` insert new line
          // editor.addCommand(1024 | monacoRef.current!.KeyCode.Enter, () => { })
          editor.onDidFocusEditorText(() => {
            editor.trigger('anything', 'editor.action.triggerSuggest', () => { })
            editor.trigger('anything', 'editor.action.triggerParameterHints', () => { })
          })
        }}
        onChange={(v) => {
          stringToAction(v)
        }}
      />
      {debug && (
        <div>
          <span style={{ backgroundColor: "orange" }}>output(raw json):</span>
          <pre>
            {JSON.stringify(parseStr, null, 2)}
          </pre>
          <span style={{ backgroundColor: "orange" }}>converted from raw json:</span>
          <pre>
            {convertedStr}
          </pre>
        </div>
      )}
    </>
  )
}

export default TextScriptEditor