const fs = require('fs');
const path = require('path');

const apiDataPath = path.join(__dirname, 'api_data.json');
const templatePath = path.join(__dirname, 'syntaxes', 'angelscript.tmLanguage.template.json');
const outputPath = path.join(__dirname, 'syntaxes', 'angelscript.tmLanguage.json');

console.log('Generating AngelScript grammar from API data...');

// --- Helper Functions ---
function escapeRegExp(string) {
    // $& means the whole matched string
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getBaseFuncName(declaration) {
    if (!declaration) return null;
    // Regex to capture the function/method/operator name, handling return types etc.
    // Examples: void func(), type func(), type opAdd(), list<type>@ func()
    const match = declaration.match(/(?:(?:[a-zA-Z_]\w*(?:<.*?>)?(?:@|&)?)\s+)?(op[A-Z]\w*|[a-zA-Z_]\w*)\s*\(/);
    const name = match ? match[1] : null;
    // Exclude internal/constructor names if necessary (e.g., starting with '$')
    return (name && !name.startsWith('$')) ? name : null;
}

// --- Main Logic ---
try {
    // 1. Read API Data
    if (!fs.existsSync(apiDataPath)) {
        throw new Error(`API data file not found: ${apiDataPath}`);
    }
    const apiDataRaw = fs.readFileSync(apiDataPath, 'utf8');
    const apiData = JSON.parse(apiDataRaw);
    console.log(`Read API data with ${apiData.objectTypes?.length || 0} object types, ${apiData.enums?.length || 0} enums, ${apiData.globalFunctions?.length || 0} global functions.`);

    // 2. Extract API Names
    const apiTypeNames = new Set();
    const apiFunctionNames = new Set(); // Base names only

    // Add known built-in types (so they aren't overridden by API if names clash)
    // These are already in the template's "support_types", but ensures API list doesn't include them redundantly
    ['string', 'array', 'void', 'bool', 'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'float', 'double'].forEach(t => apiTypeNames.add(t));


    apiData.objectTypes?.forEach(t => {
        if (t.name) apiTypeNames.add(t.name);
        t.methods?.forEach(m => {
            const name = getBaseFuncName(m.declaration);
            if (name) apiFunctionNames.add(name);
        });
        t.behaviours?.forEach(b => {
            const name = getBaseFuncName(b.declaration);
            if (name) apiFunctionNames.add(name);
        });
    });
    apiData.enums?.forEach(e => {
        if (e.name) apiTypeNames.add(e.name);
        // Add enum values as constants? Optional, makes grammar bigger.
        // e.values?.forEach(v => apiConstantNames.add(v.name));
    });
    apiData.globalFunctions?.forEach(f => {
        const name = f.name || getBaseFuncName(f.declaration);
        if (name) apiFunctionNames.add(name);
    });

    // Remove primitives from the API-specific list to avoid duplication/regex issues
    ['string', 'array', 'void', 'bool', 'int', 'int8', 'int16', 'int32', 'int64', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'float', 'double'].forEach(t => apiTypeNames.delete(t));


    // 3. Prepare Regex Patterns
    const sortedTypes = Array.from(apiTypeNames)
                           .filter(Boolean) // Remove empty/null
                           .sort((a, b) => b.length - a.length); // Longest first!
    const typePattern = sortedTypes.map(escapeRegExp).join('|');

    const sortedFunctions = Array.from(apiFunctionNames)
                               .filter(Boolean)
                               .sort((a, b) => b.length - a.length); // Longest first!
    const functionPattern = sortedFunctions.map(escapeRegExp).join('|');

    console.log(`Extracted ${sortedTypes.length} unique API type names.`);
    console.log(`Extracted ${sortedFunctions.length} unique API function base names.`);


    // 4. Read Template Grammar
    if (!fs.existsSync(templatePath)) {
        throw new Error(`Template grammar file not found: ${templatePath}`);
    }
    let grammarTemplate = fs.readFileSync(templatePath, 'utf8');

    // 5. Replace Placeholders
    // Ensure placeholders exist before replacing
    if (!grammarTemplate.includes('__API_TYPES__')) {
         console.warn("Warning: Placeholder '__API_TYPES__' not found in template.");
    } else {
         grammarTemplate = grammarTemplate.replace('__API_TYPES__', typePattern || '(?!)'); // (?!) is regex that never matches
    }

    if (!grammarTemplate.includes('__API_FUNCTIONS__')) {
         console.warn("Warning: Placeholder '__API_FUNCTIONS__' not found in template.");
    } else {
        grammarTemplate = grammarTemplate.replace('__API_FUNCTIONS__', functionPattern || '(?!)');
    }


    // 6. Write Output Grammar File
    fs.writeFileSync(outputPath, grammarTemplate, 'utf8');
    console.log(`Successfully generated grammar file: ${outputPath}`);

} catch (error) {
    console.error("Error generating grammar:", error);
    process.exit(1); // Exit with error code
}