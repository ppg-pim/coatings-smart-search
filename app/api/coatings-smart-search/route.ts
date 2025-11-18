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

interface AISearchIntent {
  questionType: 'lookup' | 'comparison' | 'analytical' | 'meta'
  searchTerms: string[]
  metaType?: 'count' | 'list' | 'overview'
  filters?: {
    family?: string
    productType?: string
    productModel?: string
  }
  reasoning: string
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

// 🤖 AI-POWERED QUERY PARSER - Let ChatGPT understand the user's intent
async function parseQueryWithAI(
  query: string,
  availableFamilies: string[],
  availableTypes: string[],
  userFilters: { family?: string; productType?: string; productModel?: string }
): Promise<AISearchIntent> {
  console.log(`🤖 Using AI to parse query: "${query}"`)
  
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini', // Faster and cheaper for parsing
      messages: [
        {
          role: 'system',
          content: `You are an expert query parser for an aerospace coatings database. Your job is to analyze user queries and extract search intent.

**DATABASE STRUCTURE:**
- Products have: SKU, family, Product_Name, Product_Type, Product_Model, and various technical specifications
- Available families: ${availableFamilies.slice(0, 20).join(', ')}${availableFamilies.length > 20 ? '...' : ''}
- Available types: ${availableTypes.slice(0, 15).join(', ')}${availableTypes.length > 15 ? '...' : ''}

**YOUR TASK:**
Analyze the user's query and return a JSON object with:
1. **questionType**: 'lookup' | 'comparison' | 'analytical' | 'meta'
   - lookup: User wants specific product(s) info
   - comparison: User wants to compare 2+ products
   - analytical: User asks "what", "how", "best", "recommend"
   - meta: User asks about database itself (count, list, overview)

2. **searchTerms**: Array of product names, SKUs, or keywords to search for
   - For comparisons: Extract FULL product names (e.g., ["CA8000 Solar Reflective Topcoat", "CA8000 Solar Reflective Non-Metal Topcoat"])
   - For lookups: Extract product codes or key terms (e.g., ["CA8100", "primer"])
   - For analytical: Extract key concepts (e.g., ["corrosion protection", "high temperature"])

3. **metaType**: If questionType is 'meta', specify: 'count' | 'list' | 'overview'

4. **filters**: Detect any family/type/model filters mentioned
   - family: Look for product family codes (e.g., CA8000, 44GN)
   - productType: Look for types like "primer", "topcoat", "sealer"
   - productModel: Look for specific models

5. **reasoning**: Brief explanation of your analysis

**EXAMPLES:**

Query: "compare CA8000 Solar Reflective Topcoat to CA8000 Solar Reflective Non-Metal Topcoat"
Response: {
  "questionType": "comparison",
  "searchTerms": ["CA8000 Solar Reflective Topcoat", "CA8000 Solar Reflective Non-Metal Topcoat"],
  "filters": { "family": "CA8000" },
  "reasoning": "User wants to compare two specific CA8000 products with different characteristics"
}

Query: "what is the mix ratio of CA 8100"
Response: {
  "questionType": "lookup",
  "searchTerms": ["CA8100", "CA 8100"],
  "reasoning": "User looking for specific technical specification (mix ratio) of CA 8100 product"
}

Query: "best coating for corrosion protection"
Response: {
  "questionType": "analytical",
  "searchTerms": ["corrosion protection", "corrosion resistant", "anti-corrosion"],
  "reasoning": "User seeking recommendations based on application requirement"
}

Query: "how many products are in the CA8000 family"
Response: {
  "questionType": "meta",
  "metaType": "count",
  "searchTerms": [],
  "filters": { "family": "CA8000" },
  "reasoning": "User asking for database statistics about CA8000 family"
}

Query: "44GN060 vs 44GN057"
Response: {
  "questionType": "comparison",
  "searchTerms": ["44GN060", "44GN057"],
  "filters": { "family": "44GN" },
  "reasoning": "User wants to compare two products from 44GN family"
}

**IMPORTANT:**
- For comparison queries, extract COMPLETE product names, not fragments
- Be generous with search terms - include variations and synonyms
- Detect family codes even if not explicitly stated
- Return valid JSON only, no markdown or explanations`
        },
        {
          role: 'user',
          content: `Parse this query: "${query}"

${userFilters.family ? `User has already filtered by family: ${userFilters.family}` : ''}
${userFilters.productType ? `User has already filtered by type: ${userFilters.productType}` : ''}
${userFilters.productModel ? `User has already filtered by model: ${userFilters.productModel}` : ''}

Return JSON only.`
        }
      ],
      temperature: 0.1,
      max_tokens: 500,
      response_format: { type: 'json_object' }
    })
    
    const aiResponse = completion.choices[0].message.content || '{}'
    const parsed: AISearchIntent = JSON.parse(aiResponse)
    
    console.log(`✅ AI parsed intent:`, JSON.stringify(parsed, null, 2))
    
    return parsed
    
  } catch (error: any) {
    console.error('❌ AI parsing failed:', error.message)
    
    // Fallback to basic parsing
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2)
    return {
      questionType: 'lookup',
      searchTerms: words,
      reasoning: 'Fallback parsing due to AI error'
    }
  }
}

// Handle meta-questions
async function handleMetaQuestion(
  metaType: string,
  filters: { family?: string; productType?: string; productModel?: string },
  supabaseClient: any
): Promise<any> {
  console.log(`🔍 Handling meta-question type: ${metaType}`)
  console.log(`🎯 With filters:`, filters)
  
  try {
    if (metaType === 'count') {
      let countQuery = supabaseClient
        .from('coatings')
        .select('*', { count: 'exact', head: true })
      
      if (filters.family) countQuery = countQuery.eq('family', filters.family)
      if (filters.productType) countQuery = countQuery.ilike('Product_Type', `%${filters.productType}%`)
      if (filters.productModel) countQuery = countQuery.eq('Product_Model', filters.productModel)
      
      const { count, error } = await countQuery
      
      if (error) throw error
      
      console.log(`✅ Total products: ${count}`)
      
      let summary = `**Product Count**\n\nI found **${(count || 0).toLocaleString()} coating product${count === 1 ? '' : 's'}**`
      
      if (filters.family || filters.productType || filters.productModel) {
        summary += ' matching your criteria:\n'
        if (filters.family) summary += `\n• Family: **${filters.family}**`
        if (filters.productType) summary += `\n• Type: **${filters.productType}**`
        if (filters.productModel) summary += `\n• Model: **${filters.productModel}**`
      } else {
        summary += ' in the database.'
      }
      
      return {
        success: true,
        questionType: 'meta',
        metaType: 'count',
        summary,
        count: count || 0,
        results: []
      }
    }
    
    if (metaType === 'list') {
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
      
      const summary = `**Product Categories**

**Families (${families.length}):**
${families.slice(0, 20).map(f => `• ${f}`).join('\n')}
${families.length > 20 ? `\n_...and ${families.length - 20} more_` : ''}

**Types (${types.length}):**
${types.slice(0, 15).map(t => `• ${t}`).join('\n')}
${types.length > 15 ? `\n_...and ${types.length - 15} more_` : ''}`
      
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
    
    if (metaType === 'overview') {
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
**Product Families:** ${families.length} unique families

**Search Capabilities:**
• Natural language search powered by AI
• Product comparisons with detailed analysis
• Filter by family, type, and model
• Technical specification lookup

**Example Queries:**
• "Best coating for corrosion protection"
• "Compare CA8000 Solar Reflective Topcoat to CA8000 Non-Metal Topcoat"
• "What is the mix ratio of CA 8100"
• "Show me all primers in the 44GN family"`
      
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
    console.error('❌ Meta-question error:', error)
    throw error
  }
  
  return null
}

// 🔍 Smart database search using AI-extracted terms
async function smartDatabaseSearch(
  searchTerms: string[],
  filters: { family?: string; productType?: string; productModel?: string },
  supabaseClient: any
): Promise<ProductRecord[]> {
  console.log(`🔍 Smart search for terms: ${searchTerms.join(' | ')}`)
  
  const allResults: ProductRecord[] = []
  const seenIds = new Set<string>()
  
  try {
    for (const term of searchTerms) {
      // Split multi-word terms for better matching
      const keywords = term.split(/\s+/).filter(k => k.length > 2)
      
      for (const keyword of keywords) {
        let query = supabaseClient
          .from('coatings')
          .select('*')
        
        // Apply user filters
        if (filters.family) query = query.eq('family', filters.family)
        if (filters.productType) query = query.ilike('Product_Type', `%${filters.productType}%`)
        if (filters.productModel) query = query.eq('Product_Model', filters.productModel)
        
        // Search across multiple columns
        query = query.or(
          `sku.ilike.%${keyword}%,` +
          `family.ilike.%${keyword}%,` +
          `Product_Name.ilike.%${keyword}%,` +
          `Product_Type.ilike.%${keyword}%,` +
          `Product_Model.ilike.%${keyword}%,` +
          `Product_Description.ilike.%${keyword}%`
        ).limit(100)
        
        const { data, error } = await query
        
        if (error) {
          console.error(`❌ Search error for "${keyword}":`, error)
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
        }
      }
    }
    
    console.log(`✅ Total unique results: ${allResults.length}`)
    return allResults
    
  } catch (error: any) {
    console.error('❌ Database search error:', error)
    return []
  }
}

// Rank search results by relevance to search terms
function rankSearchResults(
  products: ProductRecord[],
  searchTerms: string[]
): ProductRecord[] {
  const scored = products.map(product => {
    let score = 0
    const searchableText = [
      product.sku,
      product.family,
      product.Product_Name,
      product.Product_Type,
      product.Product_Model,
      product.Product_Description
    ].filter(Boolean).join(' ').toLowerCase()
    
    searchTerms.forEach(term => {
      const lowerTerm = term.toLowerCase()
      const keywords = lowerTerm.split(/\s+/)
      
      keywords.forEach(keyword => {
        // Exact SKU match - highest priority
        if (product.sku?.toLowerCase() === keyword) {
          score += 1000
        } else if (product.sku?.toLowerCase().includes(keyword)) {
          score += 500
        }
        
        // Family match - high priority
        if (product.family?.toLowerCase() === keyword) {
          score += 800
        } else if (product.family?.toLowerCase().includes(keyword)) {
          score += 400
        }
        
        // Product name match
        if (product.Product_Name?.toLowerCase().includes(keyword)) {
          score += 300
        }
        
        // Type and model match
        if (product.Product_Type?.toLowerCase().includes(keyword)) {
          score += 200
        }
        
        if (product.Product_Model?.toLowerCase().includes(keyword)) {
          score += 250
        }
        
        // General text match
        if (searchableText.includes(keyword)) {
          score += 100
        }
      })
    })
    
    return { product, score }
  })
  
  scored.sort((a, b) => b.score - a.score)
  
  return scored.map(s => s.product)
}

// 🎯 Smart AI system prompt
function getSmartAISystemPrompt(): string {
  return `You are an expert aerospace coatings consultant with deep technical knowledge.

**YOUR ROLE:**
Analyze product data and provide clear, accurate answers based ONLY on the data provided.

**FORMATTING RULES:**
1. Use natural paragraph text for descriptions and explanations
2. Use bullet points (•) ONLY for listing items or highlighting key contrasts
3. Use tables for side-by-side comparisons
4. Use **bold** for important specifications and product names
5. DO NOT include "Source" or "Reference" sections
6. Keep answers concise but complete

**EXAMPLE COMPARISON:**

| Specification | Product A | Product B |
|--------------|-----------|-----------|
| **Type** | Topcoat | Primer |
| **VOC** | 420 g/L | 340 g/L |

**Key Differences:**
• Product A is for final finish applications
• Product B is for substrate preparation

Remember: Write naturally like a technical consultant. Use bullet points sparingly.`
}

// Prepare product data for AI
function prepareProductDataForAI(products: ProductRecord[]): string {
  const productStrings = products.map((product, index) => {
    const lines: string[] = []
    lines.push(`\n${'='.repeat(80)}`)
    lines.push(`PRODUCT ${index + 1}`)
    lines.push('='.repeat(80))
    
    Object.entries(product).forEach(([key, value]) => {
      if (!key.startsWith('_') && value !== null && value !== undefined && value !== '') {
        const valueStr = String(value).substring(0, 1000)
        lines.push(`${key}: ${valueStr}`)
      }
    })
    
    return lines.join('\n')
  })
  
  return productStrings.join('\n\n')
}

// Generate AI analysis
async function generateAIAnalysis(
  products: ProductRecord[],
  userQuery: string,
  questionType: string
): Promise<string> {
  try {
    const productsToAnalyze = products.slice(0, 5)
    const productData = prepareProductDataForAI(productsToAnalyze)
    
    console.log(`🤖 Generating AI analysis for ${productsToAnalyze.length} products`)
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: getSmartAISystemPrompt()
        },
        {
          role: 'user',
          content: `**USER QUESTION:** ${userQuery}

**PRODUCT DATA:**
${productData}

Analyze and answer the user's question based on the product data above.`
        }
      ],
      temperature: 0.2,
      max_tokens: 2000
    })
    
    let response = completion.choices[0].message.content || ''
    
    // Clean up response
    response = response.replace(/\n\n.*?(?:Source|Reference)s?:.*$/is, '')
    response = response.replace(/\(Source:.*?\)/gi, '')
    response = response.replace(/<[^>]*>/g, '')
    
    console.log(`✅ AI analysis complete`)
    
    return response
    
  } catch (error: any) {
    console.error('❌ AI analysis failed:', error.message)
    return `I found ${products.length} product(s) but couldn't generate analysis. Please try again.`
  }
}

// Main POST handler
export async function POST(req: NextRequest) {
  const startTime = Date.now()
  
  try {
    const body = await req.json()
    const { query, family = '', productType = '', productModel = '' } = body
    
    // Handle filter options request
    if (query === '__GET_FILTER_OPTIONS__') {
      console.log(`\n${'='.repeat(80)}`)
      console.log(`> 🎛️ GET_FILTER_OPTIONS`)
      const filterOptions = await getFilterOptions(supabase)
      const duration = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(` ✅ Completed in ${duration}s`)
      console.log(`${'='.repeat(80)}\n`)
      return NextResponse.json(filterOptions)
    }
    
    console.log(`\n${'='.repeat(80)}`)
    console.log(`> 🔍 Query: ${query}`)
    console.log(`> 🎯 Filters: family='${family}', type='${productType}', model='${productModel}'`)
    
    if (!query || typeof query !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Invalid query' },
        { status: 400 }
      )
    }
    
    // Get available options for AI context
    const { data: familyData } = await supabase
      .from('coatings')
      .select('family')
      .not('family', 'is', null)
      .limit(100)
    
    const { data: typeData } = await supabase
      .from('coatings')
      .select('Product_Type')
      .not('Product_Type', 'is', null)
      .limit(100)
    
    const availableFamilies = familyData ? [...new Set(familyData.map((r: any) => r.family).filter(Boolean))] : []
    const availableTypes = typeData ? [...new Set(typeData.map((r: any) => r.Product_Type).filter(Boolean))] : []
    
    // 🤖 Use AI to parse the query
    const userFilters = { family, productType, productModel }
    const intent = await parseQueryWithAI(query, availableFamilies, availableTypes, userFilters)
    
    console.log(`> 📋 Intent: ${intent.questionType}`)
    console.log(`> 🔑 Search terms: ${intent.searchTerms.join(', ')}`)
    
    // Handle meta-questions
    if (intent.questionType === 'meta' && intent.metaType) {
      const filters = {
        family: family || intent.filters?.family,
        productType: productType || intent.filters?.productType,
        productModel: productModel || intent.filters?.productModel
      }
      
      const metaResult = await handleMetaQuestion(intent.metaType, filters, supabase)
      
      if (metaResult) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(1)
        console.log(` ✅ Completed in ${duration}s`)
        console.log(`${'='.repeat(80)}\n`)
        return NextResponse.json(metaResult)
      }
    }
    
    // Build combined filters
    const filters = {
      family: family || intent.filters?.family,
      productType: productType || intent.filters?.productType,
      productModel: productModel || intent.filters?.productModel
    }
    
    // Execute smart search
    const searchResults = await smartDatabaseSearch(intent.searchTerms, filters, supabase)
    console.log(`> ✅ Found ${searchResults.length} products`)
    
    if (searchResults.length === 0) {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(` ⚠️ No results in ${duration}s`)
      console.log(`${'='.repeat(80)}\n`)
      
      return NextResponse.json({
        success: false,
        error: 'No products found',
        message: `No products found matching your search. Try different keywords.`
      })
    }
    
    // Rank results
    const rankedResults = rankSearchResults(searchResults, intent.searchTerms)
    const cleanedProducts = rankedResults.map(p => cleanProductData(p))
    
    console.log(`> 🎯 Top results:`)
    cleanedProducts.slice(0, 3).forEach((p, idx) => {
      console.log(`>    ${idx + 1}. ${p.sku || 'N/A'} - ${p.Product_Name || 'N/A'}`)
    })
    
    // Generate AI analysis
    console.log(`> 🤖 Generating AI analysis...`)
    const aiSummary = await generateAIAnalysis(cleanedProducts, query, intent.questionType)
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(` ✅ Completed in ${duration}s`)
    console.log(`${'='.repeat(80)}\n`)
    
    return NextResponse.json({
      success: true,
      questionType: intent.questionType,
      products: cleanedProducts.slice(0, 50),
      summary: aiSummary,
      count: cleanedProducts.length,
      message: `Found ${cleanedProducts.length} product(s)`
    })
    
  } catch (error: any) {
    console.error('> ❌ Error:', error)
    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(` ❌ Failed in ${duration}s`)
    console.log(`${'='.repeat(80)}\n`)
    
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Internal server error'
      },
      { status: 500 }
    )
  }
}
