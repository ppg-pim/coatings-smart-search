import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

// ============================================================================
// CONFIGURATION & INITIALIZATION
// ============================================================================

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const openaiApiKey = process.env.OPENAI_API_KEY!

const supabase = createClient(supabaseUrl, supabaseKey)
const openai = new OpenAI({ apiKey: openaiApiKey })

// Constants
const QUERY_TIMEOUT_MS = 30000 // 30 seconds
const MAX_PRODUCTS_FOR_AI = 10
const MAX_PRODUCTS_PER_KEYWORD = 100
const BATCH_FETCH_LIMIT = 3000

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

type ProductRecord = Record<string, any>

interface SearchParams {
  questionType: 'lookup' | 'comparison' | 'analytical' | 'count' | 'meta'
  searchKeywords: string[]
  requireAllKeywords: boolean
  useBatchFetch: boolean
  limit?: number
  compareProducts?: string[]
  attributeQuestion?: string
}

interface FilterOptions {
  family?: string
  productType?: string
  productModel?: string
}

interface MetaQuestionResult {
  isMeta: boolean
  type: 'count' | 'list' | 'overview' | null
  hasFilter: boolean
  filterType?: 'family' | 'type' | 'model'
  filterValue?: string
}

// ============================================================================
// UTILITY: PRODUCT CODE VARIATIONS (from Sealants)
// ============================================================================

function generateSearchVariations(productCode: string): string[] {
  const variations = new Set<string>()
  
  // Original
  variations.add(productCode)
  
  // Remove all spaces and special chars
  const cleaned = productCode.replace(/[\s\-\/®™©]/g, '')
  if (cleaned.length >= 2) {
    variations.add(cleaned)
  }
  
  // Extract just the number
  const numberMatch = productCode.match(/(\d+)/)
  if (numberMatch && numberMatch[1].length >= 2) {
    variations.add(numberMatch[1])
  }
  
  // Common patterns for coatings (e.g., "44GN060", "CA 8100", "C/A-8100")
  const patterns = [
    productCode.replace(/\//g, ''),           // C/A8100 → CA8100
    productCode.replace(/\//g, ' '),          // C/A8100 → C A8100
    productCode.replace(/([A-Z\/]+)(\d+)/i, '$1 $2'), // CA8100 → CA 8100
    productCode.replace(/\//g, '').replace(/([A-Z]+)(\d+)/i, '$1 $2'), // C/A8100 → CA 8100
    productCode.replace(/[\s\-]/g, ''),       // Remove spaces and dashes
    productCode.replace(/\s+/g, ''),          // Remove all spaces
  ]
  
  patterns.forEach(p => {
    if (p.length >= 2) {
      variations.add(p)
    }
  })
  
  // Filter out very short terms (less than 2 chars)
  return Array.from(variations).filter(v => v.length >= 2)
}

// ============================================================================
// UTILITY: HTML STRIPPING & DATA CLEANING (Enhanced from Sealants)
// ============================================================================

function stripHtml(html: string): string {
  if (typeof html !== 'string') return html
  
  return html
    // Convert common HTML tags to readable format
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<li>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    
    // HTML entities - comprehensive list
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&deg;/gi, '°')
    .replace(/&reg;/gi, '®')
    .replace(/&copy;/gi, '©')
    .replace(/&trade;/gi, '™')
    .replace(/&euro;/gi, '€')
    .replace(/&pound;/gi, '£')
    .replace(/&yen;/gi, '¥')
    .replace(/&cent;/gi, '¢')
    .replace(/&sect;/gi, '§')
    .replace(/&para;/gi, '¶')
    .replace(/&middot;/gi, '·')
    .replace(/&bull;/gi, '•')
    .replace(/&hellip;/gi, '…')
    .replace(/&ndash;/gi, '–')
    .replace(/&mdash;/gi, '—')
    .replace(/&lsquo;/gi, ''')
    .replace(/&rsquo;/gi, ''')
    .replace(/&ldquo;/gi, '"')
    .replace(/&rdquo;/gi, '"')
    .replace(/&times;/gi, '×')
    .replace(/&divide;/gi, '÷')
    .replace(/&plusmn;/gi, '±')
    .replace(/&frac14;/gi, '¼')
    .replace(/&frac12;/gi, '½')
    .replace(/&frac34;/gi, '¾')
    
    // Numeric entities
    .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-fA-F]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
    
    // Catch-all for remaining entities
    .replace(/&([a-z]+);/gi, (match, entity) => {
      const entities: Record<string, string> = {
        'nbsp': ' ', 'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"', 'apos': "'",
        'deg': '°', 'reg': '®', 'copy': '©', 'trade': '™', 'euro': '€', 'pound': '£',
        'yen': '¥', 'cent': '¢', 'sect': '§', 'para': '¶', 'middot': '·', 'bull': '•',
        'hellip': '…', 'ndash': '–', 'mdash': '—', 'lsquo': ''', 'rsquo': ''',
        'ldquo': '"', 'rdquo': '"', 'times': '×', 'divide': '÷', 'plusmn': '±',
        'frac14': '¼', 'frac12': '½', 'frac34': '¾',
      }
      return entities[entity.toLowerCase()] || match
    })
    
    // Clean up excessive whitespace
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function cleanProductData(product: ProductRecord): ProductRecord {
  const cleaned: ProductRecord = {}
  const seen = new Set<string>()
  
  const excludeFields = ['embedding', 'vector', 'searchable_text']
  
  Object.keys(product).forEach(key => {
    const lowerKey = key.toLowerCase()
    
    // Skip duplicates and excluded fields
    if (seen.has(lowerKey) || excludeFields.includes(key)) return
    seen.add(lowerKey)
    
    const value = product[key]
    
    // Skip null, undefined, empty values
    if (value === null || value === undefined || value === '') return
    
    if (typeof value === 'string') {
      const cleanedValue = stripHtml(value)
      if (cleanedValue && cleanedValue !== '') {
        cleaned[key] = cleanedValue
      }
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      // Handle nested objects
      const cleanedNested = cleanProductData(value)
      if (Object.keys(cleanedNested).length > 0) {
        cleaned[key] = cleanedNested
      }
    } else {
      cleaned[key] = value
    }
  })
  
  return cleaned
}

// ============================================================================
// META-QUESTION DETECTION (Enhanced)
// ============================================================================

function detectMetaQuestion(query: string): MetaQuestionResult {
  const lowerQuery = query.toLowerCase().trim()
  
  // Check if query mentions specific product codes
  // Coatings pattern: 44GN060, CA8100, etc.
  const hasProductCode = /\b[0-9][a-z0-9]{4,}\b/i.test(lowerQuery) ||
                         /\b[a-z]{2,}\s*\d{3,}\b/i.test(lowerQuery)
  
  // Check for filter mentions
  const filterCheck = detectFilteredMetaQuestion(query)
  
  // Count questions - only if no specific product mentioned
  if (
    (lowerQuery.match(/^how many (products?|items?|coatings?|entries?)((\s+(are|do|in))?|$)/) ||
    lowerQuery.match(/^total (number of )?(products?|items?|coatings?)$/) ||
    lowerQuery.match(/^count (of )?(products?|items?|coatings?)$/)) &&
    !hasProductCode
  ) {
    console.log('🎯 Detected generic count query (no specific product)')
    return { 
      isMeta: true, 
      type: 'count',
      hasFilter: filterCheck.hasFilter,
      filterType: filterCheck.filterType || undefined,
      filterValue: filterCheck.filterValue || undefined
    }
  }
  
  // List families/types questions
  if (
    lowerQuery.match(/what (are the |kinds of |types of )?(families|family|types?|categories)/) ||
    lowerQuery.match(/list (all )?(families|family|types?|categories|products?)/) ||
    lowerQuery.match(/show (me )?(all )?(families|family|types?|categories)/)
  ) {
    return { isMeta: true, type: 'list', hasFilter: false }
  }
  
  // Database info questions
  if (
    lowerQuery.match(/what('s| is) in (the |this )?database/) ||
    lowerQuery.match(/tell me about (the |this )?database/) ||
    lowerQuery.match(/database (info|information|overview|summary)/)
  ) {
    return { isMeta: true, type: 'overview', hasFilter: false }
  }
  
  return { isMeta: false, type: null, hasFilter: false }
}

function detectFilteredMetaQuestion(query: string): { 
  hasFilter: boolean
  filterType: 'family' | 'type' | 'model' | null
  filterValue: string | null
} {
  const lowerQuery = query.toLowerCase().trim()
  
  // Skip if specific product code detected
  const hasProductCode = /\b[0-9][a-z0-9]{4,}\b/i.test(lowerQuery)
  if (hasProductCode) {
    return { hasFilter: false, filterType: null, filterValue: null }
  }
  
  // Family filter
  const familyMatch = lowerQuery.match(/(?:in|for|with|associated (?:to|with)|from|of|within)\s+(?:the\s+)?([a-z0-9]+)\s+family/i)
  if (familyMatch) {
    return { 
      hasFilter: true, 
      filterType: 'family', 
      filterValue: familyMatch[1].toUpperCase() 
    }
  }
  
  // Type filter (e.g., "how many products are primers")
  const areTypeMatch = lowerQuery.match(/(?:how many|total|count).*?(?:products?|items?|coatings?).*?(?:are|is)\s+([a-z0-9\s]+?)(?:\s+(?:in|from|for|at|on|with|within|of)\s|\s*$|\?)/i)
  if (areTypeMatch) {
    const potentialType = areTypeMatch[1].trim()
    if (potentialType.length > 0 && !['there', 'available', 'here'].includes(potentialType)) {
      console.log(`🎯 Detected "are [TYPE]" pattern: "${potentialType}"`)
      return { 
        hasFilter: true, 
        filterType: 'type', 
        filterValue: potentialType 
      }
    }
  }
  
  // Type filter (explicit)
  const typeMatch = lowerQuery.match(/(?:in|for|with|of)\s+(?:the\s+)?([a-z0-9\s]+?)\s+(?:type|product type)/i)
  if (typeMatch) {
    return { 
      hasFilter: true, 
      filterType: 'type', 
      filterValue: typeMatch[1].trim() 
    }
  }
  
  // Model filter
  const modelMatch = lowerQuery.match(/(?:in|for|with|of)\s+(?:the\s+)?([a-z0-9\s]+?)\s+(?:model|product model)/i)
  if (modelMatch) {
    return { 
      hasFilter: true, 
      filterType: 'model', 
      filterValue: modelMatch[1].trim() 
    }
  }
  
  return { hasFilter: false, filterType: null, filterValue: null }
}

// ============================================================================
// META-QUESTION HANDLER (Enhanced with Timeout Protection)
// ============================================================================

async function handleMetaQuestion(
  type: string,
  query: string,
  filters: FilterOptions,
  metaInfo?: { filterType?: string; filterValue?: string }
): Promise<any> {
  console.log(`🔍 Handling meta-question type: ${type}`)
  if (metaInfo?.filterType && metaInfo?.filterValue) {
    console.log(`🎯 With filter: ${metaInfo.filterType} = ${metaInfo.filterValue}`)
  }
  
  try {
    if (type === 'count') {
      // Build count query with timeout protection
      const countPromise = (async () => {
        let countQuery = supabase
          .from('coatings')
          .select('*', { count: 'exact', head: true })
        
        // Apply user filters
        if (filters.family) countQuery = countQuery.eq('family', filters.family)
        if (filters.productType) countQuery = countQuery.eq('Product_Type', filters.productType)
        if (filters.productModel) countQuery = countQuery.eq('Product_Model', filters.productModel)
        
        // Apply meta-question filter
        if (metaInfo?.filterType && metaInfo?.filterValue) {
          if (metaInfo.filterType === 'family') {
            countQuery = countQuery.eq('family', metaInfo.filterValue)
          } else if (metaInfo.filterType === 'type') {
            countQuery = countQuery.ilike('Product_Type', `%${metaInfo.filterValue}%`)
          } else if (metaInfo.filterType === 'model') {
            countQuery = countQuery.eq('Product_Model', metaInfo.filterValue)
          }
        }
        
        const { count, error } = await countQuery
        
        if (error) {
          console.error('❌ Error counting products:', error)
          throw error
        }
        
        return count
      })()
      
      // Timeout protection
      const timeoutPromise = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('Count query timeout after 30s')), QUERY_TIMEOUT_MS)
      )
      
      const count = await Promise.race([countPromise, timeoutPromise])
      
      console.log(`✅ Total products: ${count}`)
      
      // Build summary message
      let summary: string
      const filterParts: string[] = []
      
      if (filters.family) filterParts.push(`family "${filters.family}"`)
      if (filters.productType) filterParts.push(`type "${filters.productType}"`)
      if (filters.productModel) filterParts.push(`model "${filters.productModel}"`)
      if (metaInfo?.filterType && metaInfo?.filterValue) {
        filterParts.push(`${metaInfo.filterType} "${metaInfo.filterValue}"`)
      }
      
      const filterText = filterParts.length > 0 ? ` with ${filterParts.join(', ')}` : ''
      
      summary = `**Product Count${filterText ? ' (Filtered)' : ''}**

I found **${(count || 0).toLocaleString()} coating product${count === 1 ? '' : 's'}**${filterText}.

${count === 0 ? '⚠️ No products found matching these criteria.' : count > 100 ? 'You can use additional filters to narrow down the results.' : 'Use the search to find specific products from this set.'}`
      
      return {
        success: true,
        questionType: 'meta',
        metaType: 'count',
        summary,
        count: count || 0,
        results: [],
        appliedFilters: { ...filters, ...metaInfo }
      }
    }
    
    if (type === 'list') {
      // Get unique families, types, and models with pagination
      const fetchDistinctValues = async (column: string, limit: number = 1000) => {
        const values = new Set<string>()
        let page = 0
        const pageSize = 1000
        
        while (values.size < limit) {
          const { data, error } = await supabase
            .from('coatings')
            .select(column)
            .not(column, 'is', null)
            .neq(column, '')
            .range(page * pageSize, (page + 1) * pageSize - 1)
          
          if (error || !data || data.length === 0) break
          
          data.forEach((row: any) => {
            const value = row[column]
            if (value && typeof value === 'string' && value.trim()) {
              values.add(value.trim())
            }
          })
          
          if (data.length < pageSize) break
          page++
          
          if (page > 10) break // Safety limit
        }
        
        return Array.from(values).sort()
      }
      
      const [families, types, models] = await Promise.all([
        fetchDistinctValues('family'),
        fetchDistinctValues('Product_Type'),
        fetchDistinctValues('Product_Model')
      ])
      
      console.log(`✅ Found ${families.length} families, ${types.length} types, ${models.length} models`)
      
      const summary = `**Product Categories Overview**

**Product Families (${families.length} total):**
${families.slice(0, 20).map(f => `- ${f}`).join('\n')}
${families.length > 20 ? `\n_...and ${families.length - 20} more_` : ''}

**Product Types (${types.length} total):**
${types.slice(0, 15).map(t => `- ${t}`).join('\n')}
${types.length > 15 ? `\n_...and ${types.length - 15} more_` : ''}

**Product Models (${models.length} total):**
${models.slice(0, 15).map(m => `- ${m}`).join('\n')}
${models.length > 15 ? `\n_...and ${models.length - 15} more_` : ''}

You can filter by any of these categories using the filter options in the search interface.`
      
      return {
        success: true,
        questionType: 'meta',
        metaType: 'list',
        summary,
        families,
        types,
        models,
        results: []
      }
    }
    
    if (type === 'overview') {
      // Get comprehensive database overview
      const { count } = await supabase
        .from('coatings')
        .select('*', { count: 'exact', head: true })
      
      const { data: familyData } = await supabase
        .from('coatings')
        .select('family')
        .not('family', 'is', null)
        .limit(500)
      
      const families = [...new Set(familyData?.map((r: any) => r.family).filter(Boolean))]
      
      const summary = `**Aerospace Coatings Database Overview**

**Total Products:** ${(count || 0).toLocaleString()} coating products

**Product Families:** ${families.length} unique families including ${families.slice(0, 5).join(', ')}, and more.

**Search Capabilities:**
- Natural language search across all product specifications
- Compare products side-by-side
- Filter by family, type, and model
- AI-powered product recommendations with fallback support

**Example Queries:**
- "What is the mix ratio of CA 8100?"
- "Compare 44GN060 vs 44GN057"
- "Best coating for corrosion protection"
- "Show me all primers in the CA7000 family"`
      
      return {
        success: true,
        questionType: 'meta',
        metaType: 'overview',
        summary,
        totalCount: count || 0,
        familyCount: families.length,
        results: []
      }
    }
    
  } catch (error: any) {
    console.error('❌ Meta-question handler error:', error)
    
    // Fallback response
    return {
      success: false,
      questionType: 'meta',
      metaType: type,
      summary: `I encountered an issue while processing your request: ${error.message}. Please try again or rephrase your question.`,
      error: error.message,
      results: []
    }
  }
  
  return null
}

// ============================================================================
// QUERY PARSING (Enhanced with GPT-4o-mini)
// ============================================================================

async function parseSearchQueryWithAI(query: string, availableColumns: string[]): Promise<SearchParams> {
  try {
    console.log('🤖 Using GPT-4o-mini for query parsing...')
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a smart database search assistant for aerospace coating products. Analyze user queries and generate appropriate search parameters.

DATABASE SCHEMA:
Columns: ${availableColumns.join(', ')}

COATING PRODUCT PATTERNS:
- Product codes: 44GN060, CA8100, C/A-8100, 44GN 060, etc.
- Families: CA7000, 44GN, EC, etc.
- Types: Primer, Topcoat, Sealer, etc.

QUESTION TYPE DETECTION:

1. **COUNT QUESTIONS** (how many, count, total):
   - Set questionType: "count"
   - Extract product identifiers
   - Use searchKeywords for filtering

2. **COMPARISON QUESTIONS** (compare, vs, versus, difference):
   - Set questionType: "comparison"
   - Extract product codes to compare
   - Set compareProducts: ["product1", "product2"]

3. **ANALYTICAL QUESTIONS** (what is, tell me about, explain, best for):
   - Set questionType: "analytical"
   - Extract main topic/product
   - Set attributeQuestion if asking about specific attribute

4. **LOOKUP QUESTIONS** (show, find, search):
   - Set questionType: "lookup"
   - Extract search terms

SEARCH KEYWORD EXTRACTION:
- For product codes, extract JUST THE CORE: "44GN060" → "44GN060", "060", "44GN"
- For families, extract family name: "CA7000" → "CA7000", "CA", "7000"
- For general terms, extract meaningful keywords

RESPONSE FORMAT (JSON):
{
  "questionType": "lookup" | "count" | "comparison" | "analytical",
  "searchKeywords": ["keyword1", "keyword2"],
  "requireAllKeywords": false,
  "useBatchFetch": true,
  "limit": 100,
  "compareProducts": ["product1", "product2"],
  "attributeQuestion": "specific question about attribute"
}

EXAMPLES:

Query: "What is the mix ratio of CA 8100?"
Response:
{
  "questionType": "analytical",
  "searchKeywords": ["CA8100", "CA", "8100"],
  "requireAllKeywords": false,
  "useBatchFetch": true,
  "limit": 10,
  "attributeQuestion": "mix ratio"
}

Query: "Compare 44GN060 and 44GN057"
Response:
{
  "questionType": "comparison",
  "searchKeywords": ["44GN060", "44GN057"],
  "requireAllKeywords": false,
  "useBatchFetch": true,
  "limit": 10,
  "compareProducts": ["44GN060", "44GN057"]
}

Query: "How many products are primers?"
Response:
{
  "questionType": "count",
  "searchKeywords": ["primer"],
  "requireAllKeywords": false,
  "useBatchFetch": false,
  "limit": 1000
}`
        },
        {
          role: 'user',
          content: query
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,
      max_tokens: 500
    })
    
    const parsed = JSON.parse(completion.choices[0].message.content || '{}')
    
    console.log('✅ AI parsed query:', JSON.stringify(parsed, null, 2))
    
    return {
      questionType: parsed.questionType || 'lookup',
      searchKeywords: parsed.searchKeywords || [],
      requireAllKeywords: parsed.requireAllKeywords || false,
      useBatchFetch: parsed.useBatchFetch !== false,
      limit: parsed.limit || 100,
      compareProducts: parsed.compareProducts,
      attributeQuestion: parsed.attributeQuestion
    }
    
  } catch (error: any) {
    console.error('❌ AI parsing failed, using fallback:', error.message)
    return parseSearchQueryFallback(query)
  }
}

function parseSearchQueryFallback(query: string): SearchParams {
  console.log('🔄 Using fallback query parsing...')
  
  const lowerQuery = query.toLowerCase()
  
  // Detect comparison
  const comparisonPatterns = [
    /compare\s+([a-z0-9\s]+?)\s*(?:vs\.?|versus|and|with|to)\s*([a-z0-9\s]+?)(?:\s|$)/i,
    /\b([a-z0-9]{5,})\s*(?:vs\.?|versus|to)\s*([a-z0-9]{5,})\b/i,
    /(?:difference|different)\s+between\s+([a-z0-9\s]+?)\s+and\s+([a-z0-9\s]+?)(?:\s|$)/i,
  ]
  
  for (const pattern of comparisonPatterns) {
    const match = query.match(pattern)
    if (match) {
      const products = [match[1].trim(), match[2].trim()]
      console.log(`🔍 Detected comparison: ${products.join(' vs ')}`)
      return {
        questionType: 'comparison',
        searchKeywords: products,
        requireAllKeywords: false,
        useBatchFetch: true,
        compareProducts: products
      }
    }
  }
  
  // Detect count
  if (lowerQuery.match(/how many|count|total number/)) {
    return {
      questionType: 'count',
      searchKeywords: extractKeywords(query),
      requireAllKeywords: false,
      useBatchFetch: false,
      limit: 1000
    }
  }
  
  // Detect analytical
  const analyticalPatterns = [
    /what (is|are)/i,
    /tell me about/i,
    /explain/i,
    /best.*for/i,
    /recommend/i,
  ]
  
  if (analyticalPatterns.some(p => p.test(query))) {
    return {
      questionType: 'analytical',
      searchKeywords: extractKeywords(query),
      requireAllKeywords: false,
      useBatchFetch: true,
      limit: 50
    }
  }
  
  // Default: lookup
  return {
    questionType: 'lookup',
    searchKeywords: extractKeywords(query),
    requireAllKeywords: false,
    useBatchFetch: true,
    limit: 100
  }
}

function extractKeywords(query: string): string[] {
  const stopWords = new Set([
    'what', 'is', 'are', 'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'tell', 'me', 'about', 'how', 'does', 'do', 'can',
    'should', 'would', 'could', 'best', 'good', 'better', 'show', 'find', 'search'
  ])
  
  const words = query
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
  
  return [...new Set(words)]
}

// ============================================================================
// ENHANCED MULTI-KEYWORD SEARCH (with Variations)
// ============================================================================

async function enhancedMultiKeywordSearch(
  keywords: string[],
  filters: FilterOptions,
  limit: number = MAX_PRODUCTS_PER_KEYWORD
): Promise<ProductRecord[]> {
  console.log(`⚡ Enhanced search for: ${keywords.join(', ')}`)
  
  const startTime = Date.now()
  const allResults: ProductRecord[] = []
  const seenIds = new Set<string>()
  
  try {
    for (const keyword of keywords) {
      // Generate variations for this keyword
      const variations = generateSearchVariations(keyword)
      console.log(`  🔍 Searching variations: ${variations.slice(0, 5).join(', ')}${variations.length > 5 ? '...' : ''}`)
      
      for (const variation of variations.slice(0, 10)) { // Limit to 10 variations per keyword
        let query = supabase
          .from('coatings')
          .select('*')
        
        // Apply user filters
        if (filters.family) query = query.eq('family', filters.family)
        if (filters.productType) query = query.eq('Product_Type', filters.productType)
        if (filters.productModel) query = query.eq('Product_Model', filters.productModel)
        
        // Search across multiple columns
        query = query.or(
          `sku.ilike.%${variation}%,` +
          `family.ilike.%${variation}%,` +
          `Product_Name.ilike.%${variation}%,` +
          `Product_Model.ilike.%${variation}%,` +
          `Product_Type.ilike.%${variation}%`
        ).limit(Math.min(limit, 50))
        
        const { data, error } = await query
        
        if (error) {
          console.error(`  ❌ Error searching "${variation}":`, error.message)
          continue
        }
        
        if (data && data.length > 0) {
          console.log(`  ✓ Found ${data.length} results for "${variation}"`)
          data.forEach((item: any) => {
            const id = item.id || item.sku || JSON.stringify(item)
            if (!seenIds.has(id)) {
              seenIds.add(id)
              allResults.push(item)
            }
          })
          
          // If we found exact matches, we can stop searching variations for this keyword
          if (data.length > 0 && data.some((item: any) => 
            item.sku?.toLowerCase() === keyword.toLowerCase() ||
            item.Product_Model?.toLowerCase() === keyword.toLowerCase()
          )) {
            console.log(`  ✅ Found exact match for "${keyword}", skipping remaining variations`)
            break
          }
        }
        
        // Stop if we have enough results
        if (allResults.length >= limit) {
          console.log(`  ⚠️ Reached limit of ${limit} products`)
          break
        }
      }
      
      if (allResults.length >= limit) break
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2)
    console.log(`✅ Enhanced search found ${allResults.length} products in ${duration}s`)
    
    return allResults
    
  } catch (error: any) {
    console.error('❌ Enhanced search error:', error)
    return []
  }
}

// ============================================================================
// FUZZY SEARCH FALLBACK
// ============================================================================

async function fuzzySearchFallback(keywords: string[]): Promise<ProductRecord[]> {
  console.log(`🔄 Trying fuzzy search fallback for: ${keywords.join(', ')}`)
  
  const allResults: ProductRecord[] = []
  const seenIds = new Set<string>()
  
  try {
    for (const keyword of keywords) {
      // Try partial matches with lower threshold
      const variations = [
        keyword,
        keyword.substring(0, Math.max(3, keyword.length - 1)), // Remove last char
        keyword.replace(/\d+/g, ''), // Remove numbers
        keyword.replace(/[a-z]+/gi, ''), // Keep only numbers
      ].filter(v => v.length >= 2)
      
      for (const variation of variations) {
        const { data, error } = await supabase
          .from('coatings')
          .select('*')
          .or(
            `sku.ilike.%${variation}%,` +
            `family.ilike.%${variation}%,` +
            `Product_Name.ilike.%${variation}%,` +
            `Product_Model.ilike.%${variation}%,` +
            `Product_Type.ilike.%${variation}%,` +
            `Product_Description.ilike.%${variation}%`
          )
          .limit(20)
        
        if (error) continue
        
        if (data && data.length > 0) {
          console.log(`  ✓ Fuzzy search found ${data.length} results for "${variation}"`)
          data.forEach((item: any) => {
            const id = item.id || item.sku || JSON.stringify(item)
            if (!seenIds.has(id)) {
              seenIds.add(id)
              allResults.push(item)
            }
          })
        }
        
        if (allResults.length >= 20) break
      }
      
      if (allResults.length >= 20) break
    }
    
    if (allResults.length > 0) {
      console.log(`✅ Fuzzy search found ${allResults.length} products`)
    } else {
      console.log(`❌ Fuzzy search found no results`)
    }
    
    return allResults
    
  } catch (error: any) {
    console.error('❌ Fuzzy search error:', error)
    return []
  }
}

// ============================================================================
// RANKING & RELEVANCE SCORING
// ============================================================================

function rankSearchResults(
  products: ProductRecord[],
  keywords: string[]
): ProductRecord[] {
  const scored = products.map(product => {
    let score = 0
    const searchText = Object.values(product)
      .filter(v => typeof v === 'string')
      .join(' ')
      .toLowerCase()
    
    keywords.forEach(keyword => {
      const lowerKeyword = keyword.toLowerCase()
      
      // Exact matches (highest priority)
      if (product.sku?.toLowerCase() === lowerKeyword) score += 100
      if (product.Product_Model?.toLowerCase() === lowerKeyword) score += 90
      if (product.family?.toLowerCase() === lowerKeyword) score += 80
      
      // Partial matches in key fields
      if (product.sku?.toLowerCase().includes(lowerKeyword)) score += 50
      if (product.Product_Model?.toLowerCase().includes(lowerKeyword)) score += 45
      if (product.family?.toLowerCase().includes(lowerKeyword)) score += 40
      if (product.Product_Name?.toLowerCase().includes(lowerKeyword)) score += 30
      if (product.Product_Type?.toLowerCase().includes(lowerKeyword)) score += 20
      
      // Matches in description
      if (product.Product_Description?.toLowerCase().includes(lowerKeyword)) score += 15
      
      // General text match
      if (searchText.includes(lowerKeyword)) score += 10
      
      // Bonus for multiple keyword matches
      const keywordCount = (searchText.match(new RegExp(lowerKeyword, 'g')) || []).length
      score += keywordCount * 5
    })
    
    return { product, score }
  })
  
  // Sort by score (descending)
  scored.sort((a, b) => b.score - a.score)
  
  console.log(`📊 Top 5 scores: ${scored.slice(0, 5).map(s => s.score).join(', ')}`)
  
  return scored.map(s => s.product)
}

// ============================================================================
// SMART AI ANALYSIS (Enhanced with Fallback Support)
// ============================================================================

function getSmartAISystemPrompt(): string {
  return `You are an expert aerospace coatings consultant with deep technical knowledge.

**YOUR ROLE:**
You will receive product data from a coatings database. Your job is to:
1. **Analyze the data structure** - Understand what fields are available
2. **Extract relevant information** - Find the answer to the user's question
3. **Provide clear, accurate answers** - Based on the data provided
4. **Handle missing data gracefully** - Provide helpful alternatives when data is unavailable

**HOW TO ANSWER:**

**For specific questions** (e.g., "what is the mix ratio of CA 8100"):
- Search through ALL fields in the product data
- Find fields that contain relevant information (e.g., "Mix_Ratio", "Mixing", "Ratio")
- Extract and present the exact values
- If multiple related fields exist, show all of them
- **If data is missing:** Explain what information IS available and suggest related specifications

**For comparison questions:**
- Compare the same fields across products
- Highlight differences and similarities
- Use tables for clarity
- **If some data is missing:** Compare what IS available and note what's missing

**For general questions:**
- Provide an overview of key product characteristics
- Focus on the most important/relevant fields
- Explain technical specifications in context
- **If limited data:** Work with what's available and be transparent about limitations

**IMPORTANT RULES:**
1. **Don't assume field names** - The database structure may vary
2. **Search intelligently** - Look for keywords in field names (e.g., "mix", "ratio", "cure", "time")
3. **Be thorough** - Check all fields, not just obvious ones
4. **Cite your sources** - Mention which field the information came from (convert underscores to spaces naturally)
5. **Handle missing data professionally:**
   - State clearly: "This specific information is not available in the product data"
   - Provide related information that IS available
   - Suggest what the user might look for instead
   - Offer to help with related questions
6. **Be precise** - Use exact values from the data, don't estimate
7. **Use dashes (-) for lists, NOT bullet points (•)**

**FORMATTING:**
- Use markdown for readability
- Use **bold** for important specifications
- Use tables for comparisons
- Use dashes (-) for all lists
- Keep answers concise but complete
- Convert field names naturally (e.g., "Mix Ratio by Volume" not "Mix_Ratio_by_Volume")

**FALLBACK STRATEGIES:**

When specific data is missing:
1. **Provide related information:**
   - "While the exact mix ratio isn't specified, this product has the following mixing information: [related fields]"
   
2. **Suggest alternatives:**
   - "The cure time at 77°F isn't listed, but I can see it has a pot life of X hours and [other timing info]"
   
3. **Explain what's available:**
   - "The database shows these specifications for this product: [list available fields]"
   
4. **Offer to help differently:**
   - "I don't have that specific detail, but I can help you compare this with similar products or find products with that specification"

**EXAMPLE RESPONSES:**

**User:** "What is the mix ratio of CA 8100?"

**Good Answer (data available):**
"Based on the product data for CA 8100:
- **Mix Ratio by Volume**: 4:1:1 (Base:Activator:Reducer)
- **Mix Ratio by Weight**: 100:25:20
- **Pot Life**: 4-6 hours at 77°F

(Source: Mix Ratio by Volume, Mix Ratio by Weight, Pot Life fields)"

**Good Answer (data missing):**
"I found the CA 8100 product, but the specific mix ratio information isn't included in the available data. However, I can see these related specifications:
- **Product Type**: Polyurethane Topcoat
- **Application Method**: Spray
- **Number of Coats**: 2-3 coats recommended
- **Dry Film Thickness**: 2.0-3.0 mils per coat

For the exact mix ratio, I recommend:
1. Checking the product's Technical Data Sheet (TDS)
2. Contacting the manufacturer directly
3. Looking at similar products in the CA family that may have this information

Would you like me to help you find similar products with complete mixing specifications?"

**User:** "Compare 44GN060 and 44GN057"

**Good Answer (complete data):**
"**Key Differences:**

| Specification | 44GN060 | 44GN057 |
|--------------|---------|---------|
| Product Type | Topcoat | Primer |
| Color | Gray | Green |
| VOC Content | 420 g/L | 340 g/L |

**Similarities:**
- Both are from the 44GN family
- Both meet MIL-PRF-85285 specification
- Both have 4-6 hour pot life"

**Good Answer (partial data):**
"I found both products, but some specifications are limited. Here's what I can compare:

**Available Specifications:**

| Specification | 44GN060 | 44GN057 |
|--------------|---------|---------|
| Product Type | Topcoat | Primer |
| Family | 44GN | 44GN |
| Color | Gray | Green |

**44GN060 Additional Info:**
- Application: Spray
- Coverage: 400 sq ft/gal

**44GN057 Additional Info:**
- Dry Time: 30 minutes
- Recoat Time: 4-8 hours

**Note:** Some specifications like VOC content and detailed performance data aren't available in the database for these products. For complete technical specifications, I recommend consulting the product Technical Data Sheets.

Would you like me to help you find products with more complete data, or compare other aspects of these products?"

Remember: Your goal is to be helpful, accurate, and transparent. Always work with the data provided, acknowledge limitations, and offer constructive alternatives when information is missing.`
}

function prepareCompleteProductDataForAI(products: ProductRecord[]): string {
  const productDataStrings = products.map((product, index) => {
    const lines: string[] = []
    lines.push(`\n${'='.repeat(80)}`)
    lines.push(`PRODUCT ${index + 1}`)
    lines.push('='.repeat(80))
    
    // Send ALL fields to AI (excluding internal fields)
    Object.entries(product).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== '') {
        // Skip internal/technical fields
        if (['id', 'created_at', 'updated_at', 'embedding', 'vector'].includes(key)) {
          return
        }
        
        const valueStr = String(value).substring(0, 1000) // Limit per field
        lines.push(`${key}: ${valueStr}`)
      }
    })
    
    return lines.join('\n')
  })
  
  return productDataStrings.join('\n\n')
}

async function generateSmartAIAnalysis(
  products: ProductRecord[],
  userQuery: string,
  searchParams: SearchParams
): Promise<string> {
  try {
    // Handle no results case
    if (products.length === 0) {
      return generateNoResultsFallback(userQuery, searchParams)
    }
    
    // Send up to MAX_PRODUCTS_FOR_AI products with ALL their data
    const productsToAnalyze = products.slice(0, MAX_PRODUCTS_FOR_AI)
    const completeProductData = prepareCompleteProductDataForAI(productsToAnalyze)
    
    console.log(`🤖 Sending ${productsToAnalyze.length} products to GPT-4o (${completeProductData.length} chars)`)
    console.log(`📊 Question type: ${searchParams.questionType}`)
    
    // Create context hint based on question type
    let contextHint = ''
    if (searchParams.questionType === 'comparison') {
      contextHint = '\n\n**USER INTENT:** The user wants to compare these products. Focus on finding differences and similarities. If data is missing for comparison, note what IS available.'
    } else if (searchParams.questionType === 'analytical') {
      contextHint = '\n\n**USER INTENT:** The user is asking an analytical question. Provide detailed insights and recommendations. If specific data is missing, provide related information and helpful alternatives.'
      if (searchParams.attributeQuestion) {
        contextHint += `\n**SPECIFIC ATTRIBUTE REQUESTED:** ${searchParams.attributeQuestion}`
      }
    } else if (searchParams.questionType === 'count') {
      contextHint = '\n\n**USER INTENT:** The user wants to know how many products match their criteria. Provide a count and brief overview.'
    } else {
      contextHint = '\n\n**USER INTENT:** The user is looking up product information. Provide a clear, informative answer. If data is limited, work with what\'s available.'
    }
    
    // Add timeout protection
    const aiPromise = openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: getSmartAISystemPrompt()
        },
        {
          role: 'user',
          content: `${contextHint}

**USER QUESTION:**
${userQuery}

**PRODUCT DATA:**
${completeProductData}

Please analyze the product data above and answer the user's question. Remember to:
1. Search through ALL fields to find relevant information
2. When citing field names, convert underscores to spaces naturally
3. Use dashes (-) for all lists, NOT bullet points (•)
4. Be specific and accurate
5. **If information is missing:** Provide what IS available and suggest helpful alternatives
6. Be transparent about data limitations
7. Offer constructive next steps when data is incomplete`
        }
      ],
      temperature: 0.2, // Lower temperature for more accurate, factual responses
      max_tokens: 2000
    })
    
    const timeoutPromise = new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error('AI analysis timeout after 30s')), QUERY_TIMEOUT_MS)
    )
    
    const completion = await Promise.race([aiPromise, timeoutPromise])
    
    const aiResponse = completion.choices[0].message.content || ''
    console.log(`✅ AI analysis complete (${aiResponse.length} chars)`)
    
    return aiResponse.replace(/<[^>]*>/g, '') // Strip any HTML
    
  } catch (error: any) {
    console.error('❌ AI analysis failed:', error.message)
    
    // Fallback: Generate basic summary from available data
    return generateBasicSummaryFallback(products, userQuery, searchParams, error.message)
  }
}

// ============================================================================
// FALLBACK RESPONSES
// ============================================================================

function generateNoResultsFallback(query: string, searchParams: SearchParams): string {
  const keywords = searchParams.searchKeywords.join(', ')
  
  return `**No Products Found**

I couldn't find any coating products matching "${keywords}".

**Suggestions:**
- Try different search terms or product codes
- Check for typos in product names or codes
- Use broader search terms (e.g., search for "44GN" instead of "44GN060")
- Try searching by product type (e.g., "primer", "topcoat")
- Use the filter options to browse by family or type

**Example searches:**
- "CA 8100" or "CA8100"
- "44GN family"
- "primers for corrosion protection"
- "topcoats with low VOC"

Would you like me to help you search differently?`
}

function generateBasicSummaryFallback(
  products: ProductRecord[],
  query: string,
  searchParams: SearchParams,
  errorMessage: string
): string {
  if (products.length === 0) {
    return generateNoResultsFallback(query, searchParams)
  }
  
  const product = products[0]
  const productCount = products.length
  
  let summary = `**Search Results**

I found **${productCount} product${productCount === 1 ? '' : 's'}** matching your search, but I encountered an issue generating a detailed analysis (${errorMessage}).

`
  
  if (searchParams.questionType === 'comparison' && products.length >= 2) {
    summary += `**Products Found:**\n`
    products.slice(0, 5).forEach((p, i) => {
      summary += `${i + 1}. **${p.Product_Name || p.sku || 'Unknown Product'}**\n`
      if (p.family) summary += `   - Family: ${p.family}\n`
      if (p.Product_Type) summary += `   - Type: ${p.Product_Type}\n`
      if (p.Product_Model) summary += `   - Model: ${p.Product_Model}\n`
    })
  } else {
    // Show first product details
    summary += `**Primary Result:**\n`
    summary += `**${product.Product_Name || product.sku || 'Product'}**\n\n`
    
    // Show available key fields
    const keyFields = [
      'sku', 'family', 'Product_Type', 'Product_Model', 'Product_Description',
      'Color', 'VOC_Content', 'Mix_Ratio', 'Application_Method', 'Coverage'
    ]
    
    keyFields.forEach(field => {
      if (product[field]) {
        const displayName = field.replace(/_/g, ' ')
        const value = String(product[field]).substring(0, 200)
        summary += `- **${displayName}**: ${value}\n`
      }
    })
  }
  
  summary += `\n**Note:** For detailed analysis, please try your search again or contact support if the issue persists.`
  
  return summary
}

// ============================================================================
// FILTER OPTIONS HANDLER
// ============================================================================

async function getFilterOptions(): Promise<any> {
  console.log('🗂️ Fetching filter options...')
  
  try {
    async function fetchAllDistinctValues(columnName: string): Promise<string[]> {
      const allValues = new Set<string>()
      let page = 0
      const pageSize = 1000
      let hasMore = true
      
      while (hasMore && page < 20) { // Safety limit: 20 pages = 20,000 products
        const from = page * pageSize
        const to = from + pageSize - 1
        
        const { data, error } = await supabase
          .from('coatings')
          .select(columnName)
          .not(columnName, 'is', null)
          .neq(columnName, '')
          .order(columnName)
          .range(from, to)
        
        if (error) {
          console.error(`❌ Error fetching ${columnName}:`, error)
          break
        }
        
        if (!data || data.length === 0) break
        
        data.forEach((row: any) => {
          const value = row[columnName]
          if (value && typeof value === 'string' && value.trim() !== '') {
            allValues.add(value.trim())
          }
        })
        
        if (data.length < pageSize) {
          hasMore = false
        } else {
          page++
        }
      }
      
      console.log(`  ✓ ${columnName}: ${allValues.size} unique values`)
      return Array.from(allValues).sort()
    }
    
    console.log('📊 Fetching all filter options...')
    const startTime = Date.now()
    
    const [families, types, models] = await Promise.all([
      fetchAllDistinctValues('family'),
      fetchAllDistinctValues('Product_Type'),
      fetchAllDistinctValues('Product_Model')
    ])
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2)
    console.log(`✅ Filter options loaded in ${duration}s`)
    
    return {
      success: true,
      filterOptions: {
        families,
        productTypes: types,
        productModels: models
      }
    }
  } catch (error: any) {
    console.error('❌ Error fetching filter options:', error)
    return {
      success: false,
      error: 'Failed to fetch filter options',
      filterOptions: {
        families: [],
        productTypes: [],
        productModels: []
      }
    }
  }
}

// ============================================================================
// MAIN POST HANDLER
// ============================================================================

export async function POST(req: NextRequest) {
  const startTime = Date.now()
  
  try {
    const body = await req.json()
    const { query, family = '', productType = '', productModel = '' } = body
    
    const filters: FilterOptions = {
      family: family || undefined,
      productType: productType || undefined,
      productModel: productModel || undefined
    }
    
    // ========================================================================
    // HANDLE FILTER OPTIONS REQUEST
    // ========================================================================
    
    if (query === '__GET_FILTER_OPTIONS__') {
      console.log(`\n${'='.repeat(80)}`)
      console.log('> 🗂️ Internal request: GET_FILTER_OPTIONS')
      const filterOptions = await getFilterOptions()
      const duration = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(`✅ POST /api/coatings-smart-search 200 in ${duration}s`)
      console.log(`${'='.repeat(80)}\n`)
      return NextResponse.json(filterOptions)
    }
    
    // ========================================================================
    // VALIDATE QUERY
    // ========================================================================
    
    console.log(`\n${'='.repeat(80)}`)
    console.log(`> 🔍 User query: ${query}`)
    console.log(`> 🎯 Applied filters:`, JSON.stringify(filters, null, 2))
    
    if (!query || typeof query !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Invalid query parameter' },
        { status: 400 }
      )
    }
    
    // ========================================================================
    // GET DATABASE SCHEMA
    // ========================================================================
    
    const { data: sampleData } = await supabase
      .from('coatings')
      .select('*')
      .limit(1)
    
    const availableColumns = sampleData && sampleData.length > 0 
      ? Object.keys(sampleData[0])
      : []
    
    console.log(`> 📊 Available columns: ${availableColumns.length}`)
    
    // ========================================================================
    // CHECK FOR META-QUESTIONS
    // ========================================================================
    
    const metaCheck = detectMetaQuestion(query)
    
    if (metaCheck.isMeta && metaCheck.type) {
      console.log(`> 🎯 Detected meta-question: ${metaCheck.type}`)
      
      const metaInfo = metaCheck.hasFilter && metaCheck.filterType && metaCheck.filterValue
        ? { filterType: metaCheck.filterType, filterValue: metaCheck.filterValue }
        : undefined
      
      const metaResult = await handleMetaQuestion(metaCheck.type, query, filters, metaInfo)
      
      if (metaResult) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(1)
        console.log(`✅ POST /api/coatings-smart-search 200 in ${duration}s`)
        console.log(`${'='.repeat(80)}\n`)
        return NextResponse.json(metaResult)
      }
    }
    
    // ========================================================================
    // PARSE QUERY WITH AI
    // ========================================================================
    
    const searchParams = await parseSearchQueryWithAI(query, availableColumns)
    console.log(`> 📋 Parsed search params:`, JSON.stringify(searchParams, null, 2))
    
    // ========================================================================
    // EXECUTE SEARCH
    // ========================================================================
    
    let products: ProductRecord[] = []
    
    if (searchParams.searchKeywords.length > 0) {
      // Primary search with variations
      products = await enhancedMultiKeywordSearch(
        searchParams.searchKeywords,
        filters,
        searchParams.limit || MAX_PRODUCTS_PER_KEYWORD
      )
      
      // Fallback: Fuzzy search if no results
      if (products.length === 0) {
        console.log('⚠️ No results from primary search, trying fuzzy search...')
        products = await fuzzySearchFallback(searchParams.searchKeywords)
      }
    } else {
      // No keywords: return filtered results
      console.log('📦 No search keywords, returning filtered results...')
      let query = supabase.from('coatings').select('*')
      
      if (filters.family) query = query.eq('family', filters.family)
      if (filters.productType) query = query.eq('Product_Type', filters.productType)
      if (filters.productModel) query = query.eq('Product_Model', filters.productModel)
      
      query = query.limit(100)
      
      const { data, error } = await query
      
      if (error) {
        throw new Error(`Database query failed: ${error.message}`)
      }
      
      products = data || []
    }
    
    console.log(`> 📦 Found ${products.length} products`)
    
    // ========================================================================
    // CLEAN AND RANK RESULTS
    // ========================================================================
    
    let cleanedProducts = products.map(p => cleanProductData(p))
    
    if (searchParams.searchKeywords.length > 0) {
      cleanedProducts = rankSearchResults(cleanedProducts, searchParams.searchKeywords)
      console.log(`> 📊 Ranked ${cleanedProducts.length} products by relevance`)
    }
    
    // ========================================================================
    // GENERATE AI ANALYSIS
    // ========================================================================
    
    let aiSummary = ''
    
    if (searchParams.questionType === 'analytical' || 
        searchParams.questionType === 'comparison' ||
        (searchParams.questionType === 'lookup' && cleanedProducts.length > 0)) {
      
      console.log('> 🤖 Generating AI analysis...')
      aiSummary = await generateSmartAIAnalysis(cleanedProducts, query, searchParams)
    } else if (searchParams.questionType === 'count') {
      aiSummary = `**Product Count**

I found **${cleanedProducts.length} product${cleanedProducts.length === 1 ? '' : 's'}** matching your search criteria.

${cleanedProducts.length > 0 ? 'Use the filters or refine your search to narrow down the results.' : 'Try different search terms or adjust your filters.'}`
    }
    
    // ========================================================================
    // PREPARE RESPONSE
    // ========================================================================
    
    const response = {
      success: true,
      questionType: searchParams.questionType,
      summary: aiSummary,
      results: cleanedProducts.slice(0, 50), // Limit to 50 for response size
      totalResults: cleanedProducts.length,
      searchKeywords: searchParams.searchKeywords,
      appliedFilters: filters,
      compareProducts: searchParams.compareProducts,
      hasMoreResults: cleanedProducts.length > 50
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`✅ POST /api/coatings-smart-search 200 in ${duration}s`)
    console.log(`${'='.repeat(80)}\n`)
    
    return NextResponse
