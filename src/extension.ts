import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// --- Interfaces for api_data.json Structure ---
// (Keep Interfaces ApiData, ApiType, ApiEnum, ApiFunction, ApiMember, ApiEnumValue as before)
interface ApiData { objectTypes?: ApiType[]; enums?: ApiEnum[]; globalFunctions?: ApiFunction[]; }
interface ApiType { name: string; namespace?: string; description?: string; methods?: ApiMember[]; behaviours?: ApiMember[]; properties?: ApiMember[]; }
interface ApiEnum { name: string; namespace?: string; description?: string; values?: ApiEnumValue[]; }
interface ApiFunction { name?: string; declaration: string; namespace?: string; description?: string; }
interface ApiMember { declaration: string; description?: string; type?: string; }
interface ApiEnumValue { name: string; value: number | string; description?: string; }

// --- Interfaces for Parsed Signature Help ---
interface ParameterInfo { label: string; documentation?: string | vscode.MarkdownString; }
interface ParsedSignature { label: string; documentation?: string | vscode.MarkdownString; parameters: ParameterInfo[]; }

// --- Global Stores ---
let apiCompletionItems: vscode.CompletionItem[] = [];
let signatureMap: Map<string, ParsedSignature[]> = new Map(); // Key: ns::func, Type::Method, Type (for constructors)

// --- Helper Functions ---
function getBaseFuncName(declaration: string): string | null {
     if (!declaration) return null;
     const match = declaration.match(/(?:(?:[a-zA-Z_]\w*(?:<.*?>)?(?:@|&)?)\s+)?(op[A-Z]\w*|[a-zA-Z_]\w*)\s*\(/);
     const name = match ? match[1] : null;
     return (name && !name.startsWith('$')) ? name : null; // Ignore internal names like $beh*
}

function parseSignatureDeclaration(declaration: string, description?: string): ParsedSignature | null {
    // Regex tries to capture: (Return Type)? (NS::)?Name(Params)
    // It's adjusted to better handle constructors possibly lacking explicit return types in the regex match
    const signatureRegex = /^(?:(.+)\s+)?([\w:]+)\s*\(([^)]*)\)/;
    let match = declaration.match(signatureRegex);
    let functionName: string | undefined;
    let paramsString: string | undefined;

    if (match) {
        functionName = match[2]; // Group 2 is Name including potential namespace
        paramsString = match[3]?.trim(); // Group 3 is parameters string
    } else {
        // Fallback for constructors or simple declarations: Name(Params)
        const constructorMatch = declaration.match(/^\s*([\w:]+)\s*\(([^)]*)\)/);
        if (constructorMatch) {
            functionName = constructorMatch[1];
            paramsString = constructorMatch[2]?.trim();
        } else {
            console.warn("SignatureHelp: Failed to parse structure for:", declaration);
            return null;
        }
    }

    const parameters: ParameterInfo[] = [];
    let signatureLabel = functionName + "(";

    if (paramsString && paramsString.length > 0) {
        const paramParts = paramsString.split(/,(?![^<]*>|[^()]*\))/g); // Avoid splitting inside <> or ()
        paramParts.forEach((p, index) => {
            const trimmedParam = p.trim();
            if (trimmedParam) {
                parameters.push({ label: trimmedParam });
                signatureLabel += (index > 0 ? ", " : "") + trimmedParam;
            }
        });
    }
    signatureLabel += ")";

    return {
        label: signatureLabel,
        documentation: description || declaration,
        parameters: parameters
    };
}

// --- Function to load and process API data ---
function loadApiData(context: vscode.ExtensionContext): void {
    const apiDataPath = path.join(context.extensionPath, 'api_data.json');
    apiCompletionItems = [];
    signatureMap.clear();

    try {
        console.log(`AngelScript Extension: Loading API data from ${apiDataPath}`);
        if (!fs.existsSync(apiDataPath)) {
             vscode.window.showWarningMessage(`api_data.json not found at ${apiDataPath}. Features will be limited.`);
             return;
        }
        const apiDataRaw = fs.readFileSync(apiDataPath, 'utf8');
        const apiData: ApiData = JSON.parse(apiDataRaw);
        console.log("AngelScript Extension: API data loaded and parsed.");

        // --- Process Types ---
        apiData.objectTypes?.forEach(type => {
            if (type.name) {
                // Add Type Completion
                const typeItem = new vscode.CompletionItem(type.name, vscode.CompletionItemKind.Class);
                typeItem.detail = type.namespace ? `(type) ${type.namespace}::${type.name}` : `(type) ${type.name}`;
                typeItem.documentation = new vscode.MarkdownString(type.description || `AngelScript object type: ${type.name}`);
                apiCompletionItems.push(typeItem);

                // Helper to add members
                const processMember = (member: ApiMember, kind: vscode.CompletionItemKind, memberName: string, typeName: string) => {
                     const label = `${typeName}.${memberName}`;
                     const memberItem = new vscode.CompletionItem(label, kind);
                     const kindStr = kind !== undefined ? vscode.CompletionItemKind[kind]?.toLowerCase() ?? 'member' : 'member';
                     memberItem.detail = `(${kindStr}) ${member.declaration || memberName}`;
                     memberItem.documentation = new vscode.MarkdownString(member.description || member.declaration || `Member of ${typeName}`);
                     memberItem.insertText = memberName;
                     memberItem.filterText = label;
                     console.log(`DEBUG [loadApiData]: Adding member completion: Label="${label}", Filter="${label}"`); // DEBUG LOG
                     apiCompletionItems.push(memberItem);

                     // If it's a method, parse signature using Type::Method key
                     if (kind === vscode.CompletionItemKind.Method) {
                         const parsedSig = parseSignatureDeclaration(member.declaration, member.description);
                         if (parsedSig) {
                              const sigKey = `${typeName}::${memberName}`; // Use Type::Member as key
                             const existingSigs = signatureMap.get(sigKey) || [];
                             existingSigs.push(parsedSig);
                             signatureMap.set(sigKey, existingSigs);
                         }
                     }
                };

                // Process Methods from JSON
                type.methods?.forEach(m => {
                    const baseName = getBaseFuncName(m.declaration);
                    // Ensure method exists and has a base name before processing
                    if (baseName && m.declaration) processMember(m, vscode.CompletionItemKind.Method, baseName, type.name);
                });
                // Process Properties from JSON
                type.properties?.forEach(p => {
                     // Use declaration directly if match fails, check if it's not empty
                     const propNameMatch = p.declaration?.match(/\b([a-zA-Z_]\w*);?$/);
                     const propName = propNameMatch ? propNameMatch[1] : p.declaration?.trim();
                     if (propName) processMember(p, vscode.CompletionItemKind.Property, propName, type.name);
                 });

                 // --- Process Behaviours for Constructors ---
                 let constructorFoundInJson = false;
                 type.behaviours?.forEach(b => {
                    // Check if behaviour declaration looks like a constructor (name matches type name)
                    // Use regex that anchors to the start after potential whitespace, checks for type name as whole word
                     const constructorNameMatch = b.declaration?.match(`^\\s*${type.name}\\b\\s*\\(`);
                     if (constructorNameMatch) {
                         constructorFoundInJson = true;
                         console.log(`DEBUG [loadApiData]: Found constructor behaviour for ${type.name}: ${b.declaration}`);
                         const parsedSig = parseSignatureDeclaration(b.declaration, b.description);
                         if (parsedSig) {
                              const sigKey = type.name; // Use type name as the key for constructor signatures
                             const existingSigs = signatureMap.get(sigKey) || [];
                             existingSigs.push(parsedSig);
                             signatureMap.set(sigKey, existingSigs);
                             console.log(`DEBUG [loadApiData]: Added constructor signature for key: ${sigKey}`);
                         }
                     }
                     // TODO: Optionally process other behaviours like operators (opAdd etc.) for completion/signature help
                 });

                 // --- Add Explicit Constructor Completion Item *IF* Found ---
                 if (constructorFoundInJson) {
                     const constructorItem = new vscode.CompletionItem(`${type.name}()`, vscode.CompletionItemKind.Constructor);
                     constructorItem.detail = `(constructor) ${type.name}`;
                     const constructorBehaviour = type.behaviours?.find(b => b.declaration?.match(`^\\s*${type.name}\\b\\s*\\(`));
                     constructorItem.documentation = new vscode.MarkdownString(constructorBehaviour?.description || `Constructs a new ${type.name} object.`);
                     constructorItem.insertText = new vscode.SnippetString(`${type.name}($1)`); // Snippet places cursor inside ()
                     constructorItem.filterText = type.name; // Find by typing type name
                     apiCompletionItems.push(constructorItem);
                     console.log(`DEBUG [loadApiData]: Added constructor completion item for ${type.name}`);
                 } else if (type.name === 'filesystem') {
                     // Add specific log if filesystem constructor isn't found in behaviours
                      console.log(`DEBUG [loadApiData]: No explicit constructor behaviour found for type 'filesystem' in api_data.json. Skipping constructor completion item.`);
                 }
            }
        });

        // --- Process Enums ---
        apiData.enums?.forEach(enumType => {
             if (enumType.name) {
                 // Add Enum Type Completion
                 const enumItem = new vscode.CompletionItem(enumType.name, vscode.CompletionItemKind.Enum);
                 enumItem.detail = enumType.namespace ? `(enum) ${enumType.namespace}::${enumType.name}` : `(enum) ${enumType.name}`;
                 enumItem.documentation = new vscode.MarkdownString(enumType.description || `AngelScript enum: ${enumType.name}`);
                 apiCompletionItems.push(enumItem);

                 // Add Enum Member Completion
                 enumType.values?.forEach(val => {
                      const label = val.name;
                      const memberItem = new vscode.CompletionItem(label, vscode.CompletionItemKind.EnumMember);
                      const fullPath = `${enumType.name}::${val.name}`;
                      memberItem.detail = `(enum member) ${fullPath} = ${val.value}`;
                      memberItem.documentation = new vscode.MarkdownString(val.description || fullPath);
                      memberItem.insertText = val.name;
                      memberItem.filterText = fullPath;
                      apiCompletionItems.push(memberItem);
                 });
             }
        });

        // --- Process Global Functions ---
        apiData.globalFunctions?.forEach(func => {
             const baseName = func.name || getBaseFuncName(func.declaration);
             if (baseName && func.declaration) { // Ensure baseName and declaration exist
                 const fullName = func.namespace ? `${func.namespace}::${baseName}` : baseName;
                 // Add Global Function Completion
                 const funcItem = new vscode.CompletionItem(fullName, vscode.CompletionItemKind.Function);
                 funcItem.detail = `(function) ${func.declaration}`;
                 funcItem.documentation = new vscode.MarkdownString(func.description || func.declaration);
                 funcItem.insertText = baseName;
                 funcItem.filterText = fullName;
                 apiCompletionItems.push(funcItem);

                 // Add Global Function Signature
                 const parsedSig = parseSignatureDeclaration(func.declaration, func.description);
                 if (parsedSig) {
                      const sigKey = fullName;
                     const existingSigs = signatureMap.get(sigKey) || [];
                     existingSigs.push(parsedSig);
                     signatureMap.set(sigKey, existingSigs);
                 }
             }
        });

        console.log(`AngelScript Extension: Processed ${apiCompletionItems.length} completion items.`);
        console.log(`AngelScript Extension: Processed ${signatureMap.size} functions/methods/constructors with signatures.`);

    } catch (error) {
        console.error("AngelScript Extension: Error loading or processing API data:", error);
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Failed to load AngelScript API data: ${message}`);
    }
}

// --- SignatureHelp Provider Implementation ---
class AngelScriptSignatureHelpProvider implements vscode.SignatureHelpProvider {
    provideSignatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        context: vscode.SignatureHelpContext
    ): vscode.ProviderResult<vscode.SignatureHelp> {

        const lineText = document.lineAt(position.line).text;
        let currentArgumentIndex = 0;
        let openParenPos = -1;
        let parenBalance = 0;
        let searchPos = context.isRetrigger ? context.activeSignatureHelp?.activeSignature ?? position.character : position.character - 1;

        // Walk backwards to find function context
        for (let i = searchPos; i >= 0; i--) {
            const char = lineText[i];
            if (char === '(') {
                if (parenBalance === 0) { openParenPos = i; break; } else { parenBalance++; }
            } else if (char === ')') { parenBalance--;
            } else if (char === ',' && parenBalance === 0 && i < position.character) {
                // Simplified comma counting based on position relative to open Paren
                if (openParenPos !== -1 && i > openParenPos) { // Count only commas *after* the open paren
                    currentArgumentIndex++;
                 } else if (context.triggerCharacter === ',' && i < position.character -1) {
                      // If triggered by comma itself, increment if it's not the triggering one
                       currentArgumentIndex++;
                 }
            }
        }
        // Adjust index if triggered by '(' - means first argument is active
         if (context.triggerCharacter === '(') {
            currentArgumentIndex = 0;
         }


        if (openParenPos === -1) return undefined;

        const funcNamePart = lineText.substring(0, openParenPos).trim();
        const nameMatch = funcNamePart.match(/([a-zA-Z_][\w:]*(?:\.[a-zA-Z_]\w*)?)$/);
        let funcKey = nameMatch ? nameMatch[1] : null;

        if (!funcKey) return undefined;

        // Handle potential method calls obj.method -> lookup Type::method
        if (funcKey.includes('.')) {
             const parts = funcKey.split('.');
             const methodName = parts[parts.length - 1];
             const potentialKeys = Array.from(signatureMap.keys()).filter(k => k.endsWith(`::${methodName}`));
              if (potentialKeys.length > 0) {
                  funcKey = potentialKeys[0]; // Use first match (e.g., CorrectType::methodName)
                  console.log(`SignatureHelp: Guessed method key: ${funcKey}`);
              } else {
                   funcKey = methodName; // Fallback to just method name (might be ambiguous)
                   console.log(`SignatureHelp: Could not guess type for method, using base name: ${funcKey}`);
              }
        }

        console.log(`SignatureHelp: Looking for key "${funcKey}", Arg index: ${currentArgumentIndex}`);
        let signatures = signatureMap.get(funcKey);

        // If no direct match, check if funcKey is a type name (potential constructor call)
        if (!signatures && !funcKey.includes('::') && !funcKey.includes('.')) {
            const constructorSigs = signatureMap.get(funcKey); // Lookup by TypeName
             if (constructorSigs) {
                 console.log(`SignatureHelp: Found constructor signature(s) for key: ${funcKey}`);
                 signatures = constructorSigs;
             }
        }

        // Fallback: If namespaced key failed, try base name
         if (!signatures && funcKey.includes('::')) {
             const baseName = funcKey.substring(funcKey.lastIndexOf('::') + 2);
              const baseSignatures = signatureMap.get(baseName);
              if (baseSignatures) {
                   console.log(`SignatureHelp: Found signatures using base name: ${baseName}`);
                  signatures = baseSignatures;
              }
         }


        if (!signatures || signatures.length === 0) {
            console.log(`SignatureHelp: No signature found for key: "${funcKey}" (or fallbacks)`);
            return undefined;
        }

        return this.createSignatureHelp(signatures, currentArgumentIndex);
    }

    private createSignatureHelp(signatures: ParsedSignature[], activeParameter: number): vscode.SignatureHelp {
        const signatureHelp = new vscode.SignatureHelp();
        signatureHelp.signatures = signatures.map(sig => {
            const signatureInfo = new vscode.SignatureInformation(
                sig.label,
                sig.documentation instanceof vscode.MarkdownString ? sig.documentation : new vscode.MarkdownString(sig.documentation || '')
            );
            signatureInfo.parameters = sig.parameters.map(p => new vscode.ParameterInformation(p.label, p.documentation instanceof vscode.MarkdownString ? p.documentation : undefined));
            return signatureInfo;
        });
        signatureHelp.activeSignature = 0; // Assume first overload
        const paramCount = signatureHelp.signatures[signatureHelp.activeSignature]?.parameters.length ?? 0;
        signatureHelp.activeParameter = Math.max(0, Math.min(activeParameter, paramCount > 0 ? paramCount - 1 : 0)); // Clamp index correctly

        console.log(`SignatureHelp: Returning help. Active Sig: ${signatureHelp.activeSignature}, Active Param: ${signatureHelp.activeParameter}`);
        return signatureHelp;
    }
}

// --- Hover Provider Implementation ---
class AngelScriptHoverProvider implements vscode.HoverProvider {
    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.Hover> {

        const wordRange = document.getWordRangeAtPosition(position, /[\w:]+/); // Include :: for ns::func
        if (!wordRange) return undefined;
        const hoveredWord = document.getText(wordRange);
        console.log(`Hover: Detected word: ${hoveredWord}`);

        // 1. Check Signatures (Functions/Methods/Constructors)
        let signatures = signatureMap.get(hoveredWord);
        // If not found, check if it's a plain word that might match a constructor key
         if (!signatures && !hoveredWord.includes('::') && !hoveredWord.includes('.')) {
             signatures = signatureMap.get(hoveredWord); // Try lookup by type name for constructor
         }

        if (signatures && signatures.length > 0) {
            const hoverContent = new vscode.MarkdownString();
            hoverContent.isTrusted = true;
            signatures.forEach((sig, index) => {
                hoverContent.appendCodeblock(sig.label, 'angelscript');
                const documentation = sig.documentation instanceof vscode.MarkdownString ? sig.documentation.value : sig.documentation || '';
                if (documentation && documentation !== sig.label) hoverContent.appendMarkdown("\n---\n" + documentation);
                if (index < signatures!.length - 1) hoverContent.appendMarkdown("\n\n---\n_Overload " + (index + 2) + " of " + signatures!.length + "_\n\n"); // Separator for overloads
            });
            console.log(`Hover: Found signature(s) for ${hoveredWord}`);
            return new vscode.Hover(hoverContent, wordRange);
        }

        // 2. Check Completion Items (Types/Enums/Members etc.)
        const matchingCompletion = apiCompletionItems.find(item => item.label === hoveredWord || item.filterText === hoveredWord);
        if (matchingCompletion) {
            const hoverContent = new vscode.MarkdownString();
            hoverContent.isTrusted = true;
            const kindString = matchingCompletion.kind !== undefined ? vscode.CompletionItemKind[matchingCompletion.kind].toLowerCase() : 'item';
            hoverContent.appendMarkdown(`**(${kindString}) ${matchingCompletion.label}**\n`);
            if (matchingCompletion.detail && matchingCompletion.detail !== `(${kindString}) ${matchingCompletion.label}`) hoverContent.appendMarkdown(`*${matchingCompletion.detail}*\n`); // Add detail if different

            const documentation = matchingCompletion.documentation;
            if (documentation) {
                hoverContent.appendMarkdown("\n---\n");
                hoverContent.appendMarkdown(documentation instanceof vscode.MarkdownString ? documentation.value : documentation);
            }
            console.log(`Hover: Found completion item info for ${hoveredWord}`);
            return new vscode.Hover(hoverContent, wordRange);
        }

        console.log(`Hover: No info found for ${hoveredWord}`);
        return undefined;
    }
}


// --- Extension Activation ---
export function activate(context: vscode.ExtensionContext) {
    console.log('Extension "vscode-angelscript-syntax" is now active!');
    loadApiData(context); // Load data for all providers

    // Register Completion Provider
    const completionProvider = vscode.languages.registerCompletionItemProvider(
        'angelscript',
        {
            provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext) {
                const linePrefix = document.lineAt(position).text.substr(0, position.character);

                if (linePrefix.endsWith('.')) {
                    const filteredItems = apiCompletionItems.filter(item => item.filterText?.includes('.'));
                    console.log(`DEBUG [Completion]: Items returned for '.':`, filteredItems.map(i => i.label));
                    return filteredItems; // Return all potential members
                }
                else if (linePrefix.endsWith('::')) {
                     const namespaceMatch = linePrefix.match(/(\b[a-zA-Z_]\w*)::$/);
                     const prefix = namespaceMatch ? namespaceMatch[1] : null;
                     if (prefix) {
                         console.log("Completion: Detected '::' after prefix:", prefix);
                         const filtered = apiCompletionItems.filter(item => {
                             const itemFilter = item.filterText?.toString() || item.label.toString();
                             // Match items starting with prefix:: or enum members formatted as Enum::Member in detail/filter
                             return itemFilter.startsWith(prefix + '::') || item.detail?.toString().includes(` ${prefix}::`);
                         });
                         console.log(`DEBUG [Completion]: Items returned for '::${prefix}':`, filtered.map(i => i.label));
                         return filtered;
                     }
                     return [];
                }
                // Default: Exclude members (don't have '.' in filterText) but include constructors (label ends with '()')
                 const defaultItems = apiCompletionItems.filter(item =>
                     (!item.filterText?.includes('.')) || item.kind === vscode.CompletionItemKind.Constructor
                 );
                 console.log(`DEBUG [Completion]: Items returned for default:`, defaultItems.map(i => i.label));
                 return defaultItems;
            }
        },
        '.', ':'
    );
    context.subscriptions.push(completionProvider);

     // Register Hover Provider
     const hoverProvider = vscode.languages.registerHoverProvider(
         'angelscript',
         new AngelScriptHoverProvider()
     );
     context.subscriptions.push(hoverProvider);

    // Register Signature Help Provider
    const signatureHelpProvider = vscode.languages.registerSignatureHelpProvider(
        'angelscript',
        new AngelScriptSignatureHelpProvider(),
        '(', ','
    );
    context.subscriptions.push(signatureHelpProvider);

    // Optional Reload Command
    let disposable = vscode.commands.registerCommand('angelscript.reloadApiData', () => {
        console.log('Reloading AngelScript API data via command...');
        loadApiData(context);
        vscode.window.showInformationMessage('AngelScript API data reloaded.');
    });
    context.subscriptions.push(disposable);
}

// --- Extension Deactivation ---
export function deactivate() {
    console.log('Extension "vscode-angelscript-syntax" is deactivated.');
    apiCompletionItems = [];
    signatureMap.clear();
}