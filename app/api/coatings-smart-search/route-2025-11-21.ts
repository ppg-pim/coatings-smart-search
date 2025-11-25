import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const openaiApiKey = process.env.OPENAI_API_KEY!

const supabase = createClient(supabaseUrl, supabaseKey)
const openai = new OpenAI({ apiKey: openaiApiKey })

// Types
type ProductRecord = Record<string, any>

interface SearchParams {
  questionType: 'lookup' | 'comparison' | 'analytical'
  searchKeywords: string[]
  requireAllKeywords: boolean
  useBatchFetch: boolean
}

// Clean product data by removing null/undefined and normalizing
function cleanProductData(product: ProductRecord): ProductRecord {
  const cleaned: ProductRecord = {}
  
  Object.entries(product).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      if (typeof value === 'string') {
        let cleanedValue = value
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>/gi, '\n\n')
          .replace(/<li>/gi, '• ')
          .replace(/<\/li>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&reg;/gi, '®')
          .replace(/&trade;/gi, '™')
          .replace(/&copy;/gi, '©')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&quot;/gi, '"')
          .replace(/&#39;/gi, "'")
          .replace(/&rsquo;/gi, "'")        
          .replace(/&lsquo;/gi, "'")        
          .replace(/&rdquo;/gi, '"')        
          .replace(/&ldquo;/gi, '"')        
          .replace(/&deg;/gi, '°')          
          .replace(/&plusmn;/gi, '±')       
          .replace(/&times;/gi, '×')        
          .replace(/&divide;/gi, '÷')       
          .replace(/&ndash;/gi, '–')        
          .replace(/&mdash;/gi, '—')        
          .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
          .replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
          .replace(/\n{3,}/g, '\n\n')
          .trim()
        
        if (cleanedValue !== '') {
          cleaned[key] = cleanedValue
        }
      } else {
        cleaned[key] = value
      }
    }
  })
  
  return cleaned
}

// Handle internal filter options request
async function getFilterOptions(supabaseClient: any): Promise<any> {
  console.log(`🎛️ Fetching filter options...`)
  
  try {
    async function fetchAllDistinctValues(columnName: string): Promise<string[]> {
      const allValues = new Set<string>()
      let page = 0
      const pageSize = 1000
      let hasMore = true
      
      while (hasMore) {
        const from = page * pageSize
        const to = from + pageSize - 1
        
        const { data, error } = await supabaseClient
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
        
        if (page > 100) {
          console.warn(`⚠️ Reached page limit for ${columnName}`)
          break
        }
      }
      
      console.log(`  ✓ ${columnName}: ${allValues.size} unique values`)
      return Array.from(allValues).sort()
    }
    
    console.log(`📊 Fetching all filter options...`)
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

// Detect meta-questions about the database itself
function detectMetaQuestion(query: string): { isMeta: boolean; type: string | null } {
  const lowerQuery = query.toLowerCase().trim()
  
  const hasProductCode = /\b[0-9][a-z0-9]{4,}\b/i.test(lowerQuery)
  if (hasProductCode) {
    return { isMeta: false, type: null }
  }
  
  if (
    lowerQuery.match(/how many (products?|items?|coatings?|entries?)/) ||
    lowerQuery.match(/total (number of )?(products?|items?|coatings?)/) ||
    lowerQuery.match(/count (of )?(products?|items?|coatings?)/)
  ) {
    return { isMeta: true, type: 'count' }
  }
  
  if (
    lowerQuery.match(/what (are the |kinds of |types of )?(families|family|types?|categories)/) ||
    lowerQuery.match(/list (all )?(families|family|types?|categories|products?)/) ||
    lowerQuery.match(/show (me )?(all )?(families|family|types?|categories)/)
  ) {
    return { isMeta: true, type: 'list' }
  }
  
  if (
    lowerQuery.match(/what('s| is) in (the |this )?database/) ||
    lowerQuery.match(/tell me about (the |this )?database/) ||
    lowerQuery.match(/database (info|information|overview|summary)/)
  ) {
    return { isMeta: true, type: 'overview' }
  }
  
  return { isMeta: false, type: null }
}

// Detect if meta-question includes filters
function detectFilteredMetaQuestion(query: string): { 
  hasFilter: boolean; 
  filterType: 'family' | 'type' | 'model' | null;
  filterValue: string | null;
} {
  const lowerQuery = query.toLowerCase().trim()
  
  const hasProductCode = /\b[0-9][a-z0-9]{4,}\b/i.test(lowerQuery)
  if (hasProductCode) {
    return { hasFilter: false, filterType: null, filterValue: null }
  }
  
  const familyMatch = lowerQuery.match(/(?:in|for|with|associated (?:to|with)|from|of|within)\s+(?:the\s+)?([a-z0-9]+)\s+family/i)
  if (familyMatch) {
    return { 
      hasFilter: true, 
      filterType: 'family', 
      filterValue: familyMatch[1].toUpperCase() 
    }
  }
  
  const areTypeMatch = lowerQuery.match(/(?:how many|total|count).*?(?:products?|items?|coatings?).*?(?:are|is)\s+([a-z0-9\s]+?)(?:\s+(?:in|from|for|at|on|with|within|of)\s|\s*$|\?)/i)
  if (areTypeMatch) {
    const potentialType = areTypeMatch[1].trim()
    if (potentialType.length > 0) {
      console.log(`🎯 Detected "are [TYPE]" pattern: "${potentialType}"`)
      return { 
        hasFilter: true, 
        filterType: 'type', 
        filterValue: potentialType 
      }
    }
  }
  
  const typeMatch = lowerQuery.match(/(?:in|for|with|of)\s+(?:the\s+)?([a-z0-9\s]+?)\s+(?:type|product type)/i)
  if (typeMatch) {
    return { 
      hasFilter: true, 
      filterType: 'type', 
      filterValue: typeMatch[1].trim() 
    }
  }
  
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

// Handle meta-questions
async function handleMetaQuestion(
  type: string,
  query: string,
  supabaseClient: any,
  filterInfo?: { filterType: string; filterValue: string }
): Promise<any> {
  console.log(`🔍 Handling meta-question type: ${type}`)
  if (filterInfo) {
    console.log(`🎯 With filter: ${filterInfo.filterType} = ${filterInfo.filterValue}`)
  }
  
  try {
    if (type === 'count') {
      let countQuery = supabaseClient
        .from('coatings')
        .select('*', { count: 'exact', head: true })
      
      if (filterInfo) {
        const { filterType, filterValue } = filterInfo
        
        if (filterType === 'family') {
          countQuery = countQuery.eq('family', filterValue)
        } else if (filterType === 'type') {
          countQuery = countQuery.ilike('Product_Type', filterValue)
        } else if (filterType === 'model') {
          countQuery = countQuery.eq('Product_Model', filterValue)
        }
      }
      
      const { count, error } = await countQuery
      
      if (error) {
        console.error('❌ Error counting products:', error)
        throw error
      }
      
      console.log(`✅ Total products: ${count}`)
      
      let summary: string
      if (filterInfo) {
        const { filterType, filterValue } = filterInfo
        summary = `**Filtered Product Count**

I found **${(count || 0).toLocaleString()} coating product${count === 1 ? '' : 's'}** with ${filterType} **"${filterValue}"**.

${count === 0 ? `⚠️ No products found matching this ${filterType}.` : `This represents all products in the ${filterValue} ${filterType}.`}`
      } else {
        summary = `**Database Product Count**

I found **${(count || 0).toLocaleString()} coating products** in the database.

This represents the complete inventory of coating products available for search.`
      }
      
      return {
        success: true,
        questionType: 'meta',
        metaType: 'count',
        summary,
        count: count || 0,
        results: [],
        filter: filterInfo || null
      }
    }
    
    if (type === 'list') {
      const { data: familyData } = await supabaseClient
        .from('coatings')
        .select('family')
        .not('family', 'is', null)
        .limit(1000)
      
      const { data: typeData } = await supabaseClient
        .from('coatings')
        .select('Product_Type')
        .not('Product_Type', 'is', null)
        .limit(1000)
      
      const families = [...new Set(familyData?.map((r: any) => r.family).filter(Boolean))].sort()
      const types = [...new Set(typeData?.map((r: any) => r.Product_Type).filter(Boolean))].sort()
      
      console.log(`✅ Found ${families.length} families, ${types.length} types`)
      
      const summary = `**Product Categories Overview**

**Product Families (${families.length} total):**
${families.slice(0, 20).map(f => `• ${f}`).join('\n')}
${families.length > 20 ? `\n_...and ${families.length - 20} more_` : ''}

**Product Types (${types.length} total):**
${types.slice(0, 15).map(t => `• ${t}`).join('\n')}
${types.length > 15 ? `\n_...and ${types.length - 15} more_` : ''}

You can filter by any of these categories using the filter options in the search interface.`
      
      return {
        success: true,
        questionType: 'meta',
        metaType: 'list',
        summary,
        families,
        types,
        results: []
      }
    }
    
    if (type === 'overview') {
      const { count } = await supabaseClient
        .from('coatings')
        .select('*', { count: 'exact', head: true })
      
      const { data: familyData } = await supabaseClient
        .from('coatings')
        .select('family')
        .not('family', 'is', null)
        .limit(500)
      
      const families = [...new Set(familyData?.map((r: any) => r.family).filter(Boolean))]
      
      const summary = `**Coatings Database Overview**

**Total Products:** ${(count || 0).toLocaleString()} coating products

**Product Families:** ${families.length} unique families including ${families.slice(0, 5).join(', ')}, and more.

**Search Capabilities:**
• Natural language search across all product specifications
• Compare products side-by-side
• Filter by family, type, and model
• AI-powered product recommendations

**Example Queries:**
• "Best coating for corrosion protection"
• "Compare 44GN011 vs 44GN07"
• "Show me all primers"
• "What products are in the CA7000 family?"`
      
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
    throw error
  }
  
  return null
}

// Parse user query to determine search strategy
function parseSearchQuery(query: string): SearchParams {
  let processedQuery = query
  const concatenatedPattern = /([a-z0-9]+)(to|vs|versus)([a-z0-9]+)/gi
  processedQuery = processedQuery.replace(concatenatedPattern, '$1 $2 $3')
  
  console.log(`📝 Processed query: "${processedQuery}"`)
  
  const comparisonPatterns = [
    /compare\s+([a-z0-9\s]+?)\s*(?:vs\.?|versus|and|with|to)\s*([a-z0-9\s]+?)(?:\s|$)/i,
    /\b([a-z0-9]{5,})\s*(?:vs\.?|versus|to)\s*([a-z0-9]{5,})\b/i,
    /(?:difference|different)\s+between\s+([a-z0-9\s]+?)\s+and\s+([a-z0-9\s]+?)(?:\s|$)/i,
    /what.*?(?:difference|different).*?between\s+([a-z0-9\s]+?)\s+and\s+([a-z0-9\s]+?)(?:\s|$)/i,
    /show.*?(?:difference|different).*?between\s+([a-z0-9\s]+?)\s+and\s+([a-z0-9\s]+?)(?:\s|$)/i,
    /([a-z0-9]+)\s+and\s+([a-z0-9]+)\s+(?:comparison|compare|difference|different)/i,
    /\b([a-z0-9]{5,})\s+or\s+([a-z0-9]{5,})\b/i
  ]
  
  for (const pattern of comparisonPatterns) {
    const match = processedQuery.match(pattern)
    if (match) {
      const keywords = [match[1].trim(), match[2].trim()].filter(k => k && k.length > 0)
      
      if (keywords.length >= 2) {
        console.log(`🔍 Detected comparison: ${keywords.join(' vs ')}`)
        return {
          questionType: 'comparison',
          searchKeywords: keywords,
          requireAllKeywords: false,
          useBatchFetch: true
        }
      }
    }
  }
  
  const analyticalPatterns = [
    /what (is|are)/i,
    /tell me about/i,
    /explain/i,
    /describe/i,
    /how (does|do|can|to)/i,
    /why/i,
    /best.*for/i,
    /recommend/i,
    /suitable for/i,
    /which.*should/i
  ]
  
  const isAnalytical = analyticalPatterns.some(pattern => pattern.test(processedQuery))
  
  const stopWords = new Set([
    'what', 'is', 'are', 'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'tell', 'me', 'about', 'how', 'does', 'do', 'can',
    'should', 'would', 'could', 'best', 'good', 'better', 'vs', 'versus', 'compare', 'difference',
    'different', 'between', 'show'
  ])
  
  const words = processedQuery
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
  
  const keywords = [...new Set(words)]
  
  return {
    questionType: isAnalytical ? 'analytical' : 'lookup',
    searchKeywords: keywords,
    requireAllKeywords: false,
    useBatchFetch: keywords.length <= 3
  }
}

// Fast multi-keyword search
async function fastMultiKeywordSearch(
  keywords: string[],
  filters: { family?: string; productType?: string; productModel?: string },
  supabaseClient: any
): Promise<ProductRecord[]> {
  console.log(`⚡ Using FAST database search for: ${keywords.join(', ')}`)
  
  const startTime = Date.now()
  const allResults: ProductRecord[] = []
  const seenIds = new Set<string>()
  
  try {
    for (const keyword of keywords) {
      let query = supabaseClient
        .from('coatings')
        .select('*')
      
      if (filters.family) query = query.eq('family', filters.family)
      if (filters.productType) query = query.eq('Product_Type', filters.productType)
      if (filters.productModel) query = query.eq('Product_Model', filters.productModel)
      
      query = query.or(
        `sku.ilike.%${keyword}%,` +
        `family.ilike.%${keyword}%,` +
        `Product_Name.ilike.%${keyword}%,` +
        `Product_Model.ilike.%${keyword}%`
      ).limit(50)
      
      const { data, error } = await query
      
      if (error) {
        console.error(`❌ Error searching for "${keyword}":`, error)
        continue
      }
      
      if (data && data.length > 0) {
        console.log(`  ✓ Found ${data.length} results for "${keyword}"`)
        data.forEach((item: any) => {
          const id = item.id || item.sku || JSON.stringify(item)
          if (!seenIds.has(id)) {
            seenIds.add(id)
            allResults.push(item)
          }
        })
      } else {
        console.log(`  ⚠️ No results for "${keyword}"`)
      }
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2)
    
    if (allResults.length > 0) {
      console.log(`✅ Fast search found ${allResults.length} total products in ${duration}s`)
    } else {
      console.log(`❌ Fast search found no results in ${duration}s`)
    }
    
    return allResults
  } catch (err) {
    console.error('❌ Error in coatings search:', err)
    return []
  }
}

// Fuzzy search fallback
async function tryFuzzySearch(keyword: string): Promise<ProductRecord[]> {
  console.log(`🔍 Trying fuzzy search for: ${keyword}`)
  
  try {
    const { data, error } = await supabase
      .from('coatings')
      .select('*')
      .or(`sku.ilike.%${keyword}%,family.ilike.%${keyword}%,Product_Name.ilike.%${keyword}%,Product_Type.ilike.%${keyword}%,Product_Model.ilike.%${keyword}%`)
      .limit(20)
    
    if (error) throw error
    
    if (data && data.length > 0) {
      console.log(`✅ Fuzzy search found ${data.length} results`)
      return data
    }
  } catch (error: any) {
    console.error(`❌ Fuzzy search error:`, error)
  }
  
  return []
}

// Rank search results by relevance
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
      
      if (product.sku?.toLowerCase() === lowerKeyword) {
        score += 100
      } else if (product.sku?.toLowerCase().includes(lowerKeyword)) {
        score += 50
      }
      
      if (product.family?.toLowerCase() === lowerKeyword) {
        score += 80
      } else if (product.family?.toLowerCase().includes(lowerKeyword)) {
        score += 40
      }
      
      if (product.Product_Name?.toLowerCase().includes(lowerKeyword)) {
        score += 30
      }
      
      if (product.Product_Type?.toLowerCase().includes(lowerKeyword)) {
        score += 20
      }
      
      if (product.Product_Model?.toLowerCase().includes(lowerKeyword)) {
        score += 25
      }
      
      if (product.Product_Description?.toLowerCase().includes(lowerKeyword)) {
        score += 15
      }
      
      if (searchText.includes(lowerKeyword)) {
        score += 10
      }
    })
    
    return { product, score }
  })
  
  scored.sort((a, b) => b.score - a.score)
  
  return scored.map(s => s.product)
}

// 🎯 NEW: Smart AI system prompt - Let AI discover the data structure
function getSmartAISystemPrompt(): string {
  return `You are an expert aerospace coatings consultant with deep technical knowledge.

**YOUR ROLE:**
You will receive product data from a coatings database. Your job is to:
1. **Analyze the data structure** - Understand what fields are available
2. **Extract relevant information** - Find the answer to the user's question
3. **Provide clear, accurate answers** - Based ONLY on the data provided

**HOW TO ANSWER:**
- **For specific questions** (e.g., "what is the mix ratio of CA 8100"):
  → Search through ALL fields in the product data
  → Find fields that contain relevant information (e.g., "Mix_Ratio", "Mixing", "Ratio")
  → Extract and present the exact values
  → If multiple related fields exist, show all of them
  
- **For comparison questions**:
  → Compare the same fields across products
  → Highlight differences and similarities
  → Use tables for clarity
  
- **For general questions**:
  → Provide an overview of key product characteristics
  → Focus on the most important/relevant fields
  → Explain technical specifications in context

**IMPORTANT RULES:**
1. **Don't assume field names** - The database structure may vary
2. **Search intelligently** - Look for keywords in field names (e.g., "mix", "ratio", "cure", "time")
3. **Be thorough** - Check all fields, not just obvious ones
4. **Cite your sources** - Always mention which field the information came from, format them naturally without underscores (e.g., "Mix Ratio by Volume" instead of "Mix_Ratio_by_Volume")
5. **If data is missing** - Clearly state "This information is not available in the product data"
6. **Be precise** - Use exact values from the data, don't estimate

**FORMATTING:**
- Use markdown for readability
- Use **bold** for important specifications
- Use tables for comparisons
- Use dashes (-) for all lists, NOT bullet points (•)
- Keep answers concise but complete
- When citing field sources, use regular text without underscores (e.g., "Source: Mix Ratio by Volume" not "Source: Mix_Ratio_by_Volume")


**EXAMPLE RESPONSES:**

User: "What is the mix ratio of CA 8100?"
Good Answer: "Based on the product data for CA 8100:
- **Mix Ratio by Volume**: 4:1:1 (Base:Activator:Reducer)
- **Mix Ratio by Weight**: 100:25:20
- **Pot Life**: 4-6 hours at 77°F

(Source: Mix Ratio by Volume, Mix Ratio by Weight, Pot Life fields)"

User: "Compare 44GN060 and 44GN057"
Good Answer: "**Key Differences:**
| Specification | 44GN060 | 44GN057 |
|--------------|---------|---------|
| Product Type | Topcoat | Primer |
| Color | Gray | Green |
| VOC Content | 420 g/L | 340 g/L |

**Similarities:**
• Both are from the 44GN family
• Both meet MIL-PRF-85285 specification
• Both have 4-6 hour pot life"

Remember: Your goal is to be helpful, accurate, and thorough. Always base your answers on the actual data provided.`
}

// 🎯 NEW: Prepare complete product data for AI (send EVERYTHING)
function prepareCompleteProductDataForAI(products: ProductRecord[]): string {
  const productDataStrings = products.map((product, index) => {
    const lines: string[] = []
    lines.push(`\n${'='.repeat(80)}`)
    lines.push(`PRODUCT ${index + 1}`)
    lines.push('='.repeat(80))
    
    // Send ALL fields to AI
    Object.entries(product).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== '') {
        const valueStr = String(value).substring(0, 1000) // Limit per field
        lines.push(`${key}: ${valueStr}`)
      }
    })
    
    return lines.join('\n')
  })
  
  return productDataStrings.join('\n\n')
}

// 🎯 NEW: Universal AI analysis - Let AI figure out the answer
async function generateSmartAIAnalysis(
  products: ProductRecord[],
  userQuery: string,
  questionType: 'lookup' | 'comparison' | 'analytical'
): Promise<string> {
  try {
    // Send up to 5 products with ALL their data
    const productsToAnalyze = products.slice(0, 5)
    const completeProductData = prepareCompleteProductDataForAI(productsToAnalyze)
    
    console.log(`🤖 Sending ${productsToAnalyze.length} products to AI (${completeProductData.length} chars)`)
    console.log(`📊 Question type: ${questionType}`)
    
    // Create context hint based on question type
    let contextHint = ''
    if (questionType === 'comparison') {
      contextHint = '\n\n**USER INTENT:** The user wants to compare these products. Focus on finding differences and similarities.'
    } else if (questionType === 'analytical') {
      contextHint = '\n\n**USER INTENT:** The user is asking an analytical question. Provide detailed insights and recommendations.'
    } else {
      contextHint = '\n\n**USER INTENT:** The user is looking up product information. Provide a clear, informative answer.'
    }
    
    const completion = await openai.chat.completions.create({
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
2. When citing field names, convert underscores to spaces (e.g., "Mix Ratio by Volume" not "Mix_Ratio_by_Volume")
3. Use dashes (-) for all lists, NOT bullet points (•)
4. Be specific and accurate
5. If the information doesn't exist in the data, say so clearly`
        }
      ],
      temperature: 0.2, // Lower temperature for more accurate, factual responses
      max_tokens: 2000
    })
    
    const aiResponse = completion.choices[0].message.content || ''
    console.log(`✅ AI analysis complete (${aiResponse.length} chars)`)
    
    return aiResponse.replace(/<[^>]*>/g, '') // Strip any HTML
    
  } catch (error: any) {
    console.error('❌ AI analysis failed:', error.message)
    return `I found ${products.length} product(s) matching your search, but I'm unable to generate a detailed analysis at this time. Please try again or contact support.`
  }
}

// Main POST handler
export async function POST(req: NextRequest) {
  const startTime = Date.now()
  
  try {
    const body = await req.json()
    const { query, family = '', productType = '', productModel = '' } = body
    
    // Handle special internal filter options request
    if (query === '__GET_FILTER_OPTIONS__') {
      console.log(`\n${'='.repeat(80)}`)
      console.log(`> 🎛️ Internal request: GET_FILTER_OPTIONS`)
      const filterOptions = await getFilterOptions(supabase)
      const duration = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(` POST /api/coatings-smart-search 200 in ${duration}s`)
      console.log(`${'='.repeat(80)}\n`)
      return NextResponse.json(filterOptions)
    }
    
    console.log(`\n${'='.repeat(80)}`)
    console.log(`> 🔍 User query: ${query}`)
    console.log(`> 🎯 Applied filters: { family: '${family}', productType: '${productType}', productModel: '${productModel}' }`)
    
    if (!query || typeof query !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Invalid query parameter' },
        { status: 400 }
      )
    }
    
    // Get available columns
    const { data: sampleData } = await supabase
      .from('coatings')
      .select('*')
      .limit(1)
    
    const availableColumns = sampleData && sampleData.length > 0 
      ? Object.keys(sampleData[0]).length 
      : 0
    
    console.log(`> 📊 Available columns: ${availableColumns}`)
    
    // Parse search parameters
    const searchParams = parseSearchQuery(query)
    console.log(`> 📋 Parsed search params:`, JSON.stringify(searchParams, null, 2))
    
    // Check for meta-questions
    const metaCheck = detectMetaQuestion(query)
    const filterCheck = detectFilteredMetaQuestion(query)
    
    if (metaCheck.isMeta && metaCheck.type) {
      if (filterCheck.hasFilter && filterCheck.filterType && filterCheck.filterValue) {
        console.log(`> 🎯 Detected filtered meta-question: ${metaCheck.type} with ${filterCheck.filterType} = ${filterCheck.filterValue}`)
        
        const metaResult = await handleMetaQuestion(
          metaCheck.type,
          query,
          supabase,
          {
            filterType: filterCheck.filterType,
            filterValue: filterCheck.filterValue
          }
        )
        
        if (metaResult) {
          const duration = ((Date.now() - startTime) / 1000).toFixed(1)
          console.log(` POST /api/coatings-smart-search 200 in ${duration}s`)
          console.log(`${'='.repeat(80)}\n`)
          return NextResponse.json(metaResult)
        }
      } else {
        console.log(`> 🎯 Detected meta-question type: ${metaCheck.type}`)
        const metaResult = await handleMetaQuestion(metaCheck.type, query, supabase)
        if (metaResult) {
          const duration = ((Date.now() - startTime) / 1000).toFixed(1)
          console.log(` POST /api/coatings-smart-search 200 in ${duration}s`)
          console.log(`${'='.repeat(80)}\n`)
          return NextResponse.json(metaResult)
        }
      }
    }
    
    // Continue with normal search
    const searchKeywords = searchParams.searchKeywords
    console.log(`> 🔑 Search keywords:`, searchKeywords.join(', '))
    console.log(`> ❓ Question type: ${searchParams.questionType}`)
    
    if (searchKeywords.length === 0) {
      return NextResponse.json({
        success: false,
        error: 'No valid search keywords found',
        message: 'Please provide specific product names, SKUs, or families to search for.'
      })
    }
    
    // Build filters
    const filters: { family?: string; productType?: string; productModel?: string } = {}
    if (family) filters.family = family
    if (productType) filters.productType = productType
    if (productModel) filters.productModel = productModel
    
    // Execute fast search
    console.log(`> ⚡ Using optimized fast search strategy!`)
    const searchResults = await fastMultiKeywordSearch(searchKeywords, filters, supabase)
    console.log(`> ✅ Search returned ${searchResults.length} matching products`)
    
    // Rank results
    const rankedResults = rankSearchResults(searchResults, searchKeywords)
    
    // Log top results
    if (rankedResults.length > 0) {
      console.log(`> 🎯 Top 5 results:`)
      rankedResults.slice(0, 5).forEach((p, idx) => {
        console.log(`>    ${idx + 1}. SKU: ${p.sku || 'N/A'} (Family: ${p.family || 'N/A'})`)
      })
    }
    
    // Handle no results
    if (rankedResults.length === 0) {
      console.log(`> ⚠️ No exact matches found, trying fallback strategies...`)
      
      const fuzzyResults: ProductRecord[] = []
      for (const keyword of searchKeywords) {
        const results = await tryFuzzySearch(keyword)
        fuzzyResults.push(...results)
      }
      
      if (fuzzyResults.length > 0) {
        console.log(`> ✅ Fuzzy search found ${fuzzyResults.length} results`)
        const cleanedResults = fuzzyResults.map(p => cleanProductData(p))
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(1)
        console.log(` POST /api/coatings-smart-search 200 in ${duration}s`)
        console.log(`${'='.repeat(80)}\n`)
        
        return NextResponse.json({
          success: true,
          questionType: searchParams.questionType,
          products: cleanedResults,
          count: cleanedResults.length,
          message: `Found ${cleanedResults.length} similar product(s) using fuzzy search`
        })
      }
      
      console.log(`> ❌ No results found even with fuzzy search`)
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(` POST /api/coatings-smart-search 200 in ${duration}s`)
      console.log(`${'='.repeat(80)}\n`)
      
      return NextResponse.json({
        success: false,
        error: 'No products found',
        message: `No products found matching: ${searchKeywords.join(', ')}. Try different keywords or check the spelling.`
      })
    }
    
    // Clean products
    const cleanedProducts = rankedResults.map(p => cleanProductData(p))
    
    // 🎯 Handle comparison queries with SMART AI
    if (searchParams.questionType === "comparison") {
      console.log(`> 📊 Comparison mode - using smart AI analysis`)
      
      const productsByKeyword = new Map<string, ProductRecord[]>()
      
      searchKeywords.forEach(keyword => {
        const matchingProducts = cleanedProducts.filter(product => {
          const searchText = Object.values(product)
            .filter(v => typeof v === 'string')
            .join(' ')
            .toLowerCase()
          return searchText.includes(keyword.toLowerCase())
        })
        
        if (matchingProducts.length > 0) {
          productsByKeyword.set(keyword, matchingProducts)
        }
      })
      
      const comparisonProducts: ProductRecord[] = []
      
      productsByKeyword.forEach((products, keyword) => {
        comparisonProducts.push(products[0])
      })
      
      const missingKeywords = searchKeywords.filter(k => !Array.from(productsByKeyword.keys()).includes(k))
      
      if (missingKeywords.length > 0) {
        for (const keyword of missingKeywords) {
          const fuzzyResults = await tryFuzzySearch(keyword)
          if (fuzzyResults.length > 0) {
            comparisonProducts.push(cleanProductData(fuzzyResults[0]))
          }
        }
      }
      
      const uniqueProducts = Array.from(
        new Map(comparisonProducts.map(p => [p.sku?.toLowerCase(), p])).values()
      )
      
      console.log(`> 🤖 Generating SMART AI comparison analysis`)
      const aiSummary = await generateSmartAIAnalysis(uniqueProducts, query, 'comparison')
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(` POST /api/coatings-smart-search 200 in ${duration}s`)
      console.log(`${'='.repeat(80)}\n`)
      
      return NextResponse.json({
        success: true,
        questionType: "comparison",
        products: uniqueProducts,
        summary: aiSummary,
        count: uniqueProducts.length,
        message: `Comparing ${uniqueProducts.length} product(s)`
      })
    }
    
    // 🎯 Handle analytical queries with SMART AI
    if (searchParams.questionType === "analytical") {
      console.log(`> 🤖 Analytical mode - using smart AI analysis`)
      
      const topProducts = cleanedProducts.slice(0, 10)
      const aiSummary = await generateSmartAIAnalysis(topProducts, query, 'analytical')
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(` POST /api/coatings-smart-search 200 in ${duration}s`)
      console.log(`${'='.repeat(80)}\n`)
      
      return NextResponse.json({
        success: true,
        questionType: "analytical",
        products: topProducts,
        summary: aiSummary,
        count: topProducts.length,
        totalFound: rankedResults.length,
        message: `Found ${rankedResults.length} product(s) with AI analysis`
      })
    }
    
    // 🎯 Handle lookup queries with SMART AI
    console.log(`> 📋 Lookup mode - using smart AI analysis`)
    const topResults = cleanedProducts.slice(0, 50)
    const lookupSummary = await generateSmartAIAnalysis(topResults.slice(0, 5), query, 'lookup')
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(` POST /api/coatings-smart-search 200 in ${duration}s`)
    console.log(`${'='.repeat(80)}\n`)
    
    return NextResponse.json({
      success: true,
      questionType: "lookup",
      products: topResults,
      summary: lookupSummary,
      count: topResults.length,
      totalFound: rankedResults.length,
      message: `Found ${rankedResults.length} product(s)`
    })
    
  } catch (error: any) {
    console.error('> ❌ Search error:', error)
    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(` POST /api/coatings-smart-search 500 in ${duration}s`)
    console.log(`${'='.repeat(80)}\n`)
    
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Internal server error',
        details: error.toString()
      },
      { status: 500 }
    )
  }
}
