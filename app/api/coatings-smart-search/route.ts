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
    // Only include non-null, non-undefined values
    if (value !== null && value !== undefined) {
      // Convert empty strings to undefined
      if (typeof value === 'string' && value.trim() === '') {
        return
      }
      cleaned[key] = value
    }
  })
  
  return cleaned
}

// Handle internal filter options request - OPTIMIZED VERSION
async function getFilterOptions(supabaseClient: any): Promise<any> {
  console.log(`🎛️ Fetching filter options...`)
  
  try {
    // Helper function to fetch all distinct values efficiently
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
        
        if (!data || data.length === 0) {
          break
        }
        
        // Add to set for deduplication
        data.forEach((row: any) => {
          const value = row[columnName]
          if (value && typeof value === 'string' && value.trim() !== '') {
            allValues.add(value.trim())
          }
        })
        
        // If we got fewer results than page size, we're done
        if (data.length < pageSize) {
          hasMore = false
        } else {
          page++
        }
        
        // Safety limit to prevent infinite loops
        if (page > 100) {
          console.warn(`⚠️ Reached page limit for ${columnName}`)
          break
        }
      }
      
      console.log(`  ✓ ${columnName}: ${allValues.size} unique values`)
      return Array.from(allValues).sort()
    }
    
    // Fetch all filters in parallel for speed
    console.log(`📊 Fetching all filter options...`)
    const startTime = Date.now()
    
    const [families, types, models] = await Promise.all([
      fetchAllDistinctValues('family'),
      fetchAllDistinctValues('Product_Type'),
      fetchAllDistinctValues('Product_Model')
    ])
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2)
    console.log(`✅ Filter options loaded in ${duration}s: ${families.length} families, ${types.length} types, ${models.length} models`)
    
    return {
      success: true,
      filterOptions: {
        families,
        productTypes: types,
        productModels: models
      },
      stats: {
        familyCount: families.length,
        typeCount: types.length,
        modelCount: models.length,
        loadTime: duration
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
  
  // Count questions
  if (
    lowerQuery.match(/how many (products?|items?|coatings?|entries?)/) ||
    lowerQuery.match(/total (number of )?(products?|items?|coatings?)/) ||
    lowerQuery.match(/count (of )?(products?|items?|coatings?)/)
  ) {
    return { isMeta: true, type: 'count' }
  }
  
  // List families/types questions
  if (
    lowerQuery.match(/what (are the |kinds of |types of )?(families|family|types?|categories)/) ||
    lowerQuery.match(/list (all )?(families|family|types?|categories|products?)/) ||
    lowerQuery.match(/show (me )?(all )?(families|family|types?|categories)/)
  ) {
    return { isMeta: true, type: 'list' }
  }
  
  // Database info questions
  if (
    lowerQuery.match(/what('s| is) in (the |this )?database/) ||
    lowerQuery.match(/tell me about (the |this )?database/) ||
    lowerQuery.match(/database (info|information|overview|summary)/)
  ) {
    return { isMeta: true, type: 'overview' }
  }
  
  return { isMeta: false, type: null }
}

// Handle meta-questions about the database
async function handleMetaQuestion(
  type: string,
  query: string,
  supabaseClient: any
): Promise<any> {
  console.log(`🔍 Handling meta-question type: ${type}`)
  
  try {
    if (type === 'count') {
      // Count total products
      const { count, error } = await supabaseClient
        .from('coatings')
        .select('*', { count: 'exact', head: true })
      
      if (error) {
        console.error('❌ Error counting products:', error)
        throw error
      }
      
      console.log(`✅ Total products: ${count}`)
      
      const summary = `**Database Product Count**

I found **${(count || 0).toLocaleString()} coating products** in the database.

This represents the complete inventory of coating products available for search.`
      
      return {
        success: true,
        questionType: 'meta',
        metaType: 'count',
        summary,
        count: count || 0,
        results: []
      }
    }
    
    if (type === 'list') {
      // Get unique families, types, and models
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
      // Get comprehensive database overview
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
  const lowerQuery = query.toLowerCase()
  
  // Detect comparison queries
  const comparisonPatterns = [
    /compare\s+(\w+)\s+(vs\.?|versus|and|with)\s+(\w+)/i,
    /(\w+)\s+(vs\.?|versus)\s+(\w+)/i,
    /difference between\s+(\w+)\s+and\s+(\w+)/i,
    /(\w+)\s+or\s+(\w+)/i
  ]
  
  for (const pattern of comparisonPatterns) {
    const match = query.match(pattern)
    if (match) {
      const keywords = match.slice(1).filter(k => !['vs', 'vs.', 'versus', 'and', 'or', 'with'].includes(k.toLowerCase()))
      return {
        questionType: 'comparison',
        searchKeywords: keywords,
        requireAllKeywords: false,
        useBatchFetch: true
      }
    }
  }
  
  // Detect analytical queries
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
  
  const isAnalytical = analyticalPatterns.some(pattern => pattern.test(query))
  
  // Extract keywords (remove common words)
  const stopWords = new Set([
    'what', 'is', 'are', 'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'tell', 'me', 'about', 'how', 'does', 'do', 'can',
    'should', 'would', 'could', 'best', 'good', 'better', 'vs', 'versus', 'compare', 'difference'
  ])
  
  const words = query
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w))
  
  // Remove duplicates
  const keywords = [...new Set(words)]
  
  return {
    questionType: isAnalytical ? 'analytical' : 'lookup',
    searchKeywords: keywords,
    requireAllKeywords: false,
    useBatchFetch: keywords.length <= 3
  }
}

// SIMPLIFIED fast search - focuses on most important columns only
async function fastMultiKeywordSearch(
  keywords: string[],
  filters: { family?: string; productType?: string; productModel?: string },
  supabaseClient: any
): Promise<ProductRecord[]> {
  console.log(`⚡ Using FAST database search for: ${keywords.join(', ')}`)
  
  const startTime = Date.now()
  
  try {
    // Build a simple query focusing on SKU first (most common search)
    const keyword = keywords[0]?.toLowerCase() || ''
    
    let query = supabaseClient
      .from('coatings')
      .select('*')
    
    // Apply filters
    if (filters.family) query = query.eq('family', filters.family)
    if (filters.productType) query = query.eq('Product_Type', filters.productType)
    if (filters.productModel) query = query.eq('Product_Model', filters.productModel)
    
    // Simple OR search on key columns only
    query = query.or(
      `sku.ilike.%${keyword}%,` +
      `Product_Name.ilike.%${keyword}%,` +
      `Product_Model.ilike.%${keyword}%`
    ).limit(100)
    
    const { data, error } = await query
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2)
    
    if (error) {
      console.error('❌ Error in coatings search:', error)
      return []
    }
    
    if (data && data.length > 0) {
      console.log(`✅ Fast search found ${data.length} products in ${duration}s`)
      return data
    } else {
      console.log(`❌ Fast search found no results in ${duration}s`)
      return []
    }
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
      
      // Exact match in SKU (highest priority)
      if (product.sku?.toLowerCase() === lowerKeyword) {
        score += 100
      } else if (product.sku?.toLowerCase().includes(lowerKeyword)) {
        score += 50
      }
      
      // Exact match in family
      if (product.family?.toLowerCase() === lowerKeyword) {
        score += 80
      } else if (product.family?.toLowerCase().includes(lowerKeyword)) {
        score += 40
      }
      
      // Match in Product_Name (correct column name)
      if (product.Product_Name?.toLowerCase().includes(lowerKeyword)) {
        score += 30
      }
      
      // Match in product type
      if (product.Product_Type?.toLowerCase().includes(lowerKeyword)) {
        score += 20
      }
      
      // Match in product model
      if (product.Product_Model?.toLowerCase().includes(lowerKeyword)) {
        score += 25
      }
      
      // Match in Product_Description
      if (product.Product_Description?.toLowerCase().includes(lowerKeyword)) {
        score += 15
      }
      
      // Match anywhere else
      if (searchText.includes(lowerKeyword)) {
        score += 10
      }
    })
    
    return { product, score }
  })
  
  // Sort by score descending
  scored.sort((a, b) => b.score - a.score)
  
  return scored.map(s => s.product)
}

// Truncate product data for AI processing
function truncateProductForAI(product: ProductRecord, maxLength: number = 2000): string {
  // Updated with correct column names
  const important = [
    'sku', 
    'family', 
    'Product_Name', 
    'Product_Type', 
    'Product_Model', 
    'Product_Description'
  ]
  
  let result = ''
  
  // Add important fields first
  important.forEach(key => {
    if (product[key]) {
      result += `${key}: ${product[key]}\n`
    }
  })
  
  // Add other fields until we hit the limit
  Object.entries(product).forEach(([key, value]) => {
    if (!important.includes(key) && value && result.length < maxLength) {
      const addition = `${key}: ${value}\n`
      if (result.length + addition.length < maxLength) {
        result += addition
      }
    }
  })
  
  return result.substring(0, maxLength)
}

// Strip HTML tags
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '')
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
    
    // Check if this is a meta-question
    const metaCheck = detectMetaQuestion(query)
    if (metaCheck.isMeta && metaCheck.type) {
      console.log(`> 🎯 Detected meta-question type: ${metaCheck.type}`)
      const metaResult = await handleMetaQuestion(metaCheck.type, query, supabase)
      if (metaResult) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(1)
        console.log(` POST /api/coatings-smart-search 200 in ${duration}s`)
        console.log(`${'='.repeat(80)}\n`)
        return NextResponse.json(metaResult)
      }
    }
    
    // Continue with normal search if not a meta-question
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
      
      // Try fuzzy search for each keyword
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
    
    // Handle comparison queries
    if (searchParams.questionType === "comparison") {
      console.log(`> 📊 Comparison mode - analyzing products for comparison`)
      
      // Group products by keyword match
      const productsByKeyword = new Map<string, ProductRecord[]>()
      
      searchKeywords.forEach(keyword => {
        const matchingProducts = rankedResults.filter(product => {
          const searchText = Object.values(product)
            .filter(v => typeof v === 'string')
            .join(' ')
            .toLowerCase()
          return searchText.includes(keyword.toLowerCase())
        })
        
        if (matchingProducts.length > 0) {
          productsByKeyword.set(keyword, matchingProducts)
          console.log(`>    ✓ Found ${matchingProducts.length} products matching "${keyword}"`)
        } else {
          console.log(`>    ⚠️ No products found matching "${keyword}"`)
        }
      })
      
      // Select best representative from each keyword group
      const comparisonProducts: ProductRecord[] = []
      const keywordCoverage: string[] = []
      
      productsByKeyword.forEach((products, keyword) => {
        // Get the highest scored product for this keyword
        const bestProduct = products[0]
        comparisonProducts.push(bestProduct)
        keywordCoverage.push(keyword)
        console.log(`>    → Selected: ${bestProduct.sku || 'Unknown'} for "${keyword}"`)
      })
      
      // If we don't have products for all keywords, try fuzzy search for missing ones
      const missingKeywords = searchKeywords.filter(k => !keywordCoverage.includes(k))
      
      if (missingKeywords.length > 0) {
        console.log(`> ⚠️ Missing products for: ${missingKeywords.join(', ')}`)
        console.log(`> 🔍 Attempting fuzzy search for missing keywords...`)
        
        for (const keyword of missingKeywords) {
          const fuzzyResults = await tryFuzzySearch(keyword)
          if (fuzzyResults.length > 0) {
            const cleanedProduct = cleanProductData(fuzzyResults[0])
            comparisonProducts.push(cleanedProduct)
            console.log(`>    ✓ Found via fuzzy search: ${cleanedProduct.sku || 'Unknown'} for "${keyword}"`)
          } else {
            console.log(`>    ❌ No fuzzy results for "${keyword}"`)
          }
        }
      }
      
      // Generate AI comparison summary
      let comparisonSummary = ''
      if (comparisonProducts.length >= 2) {
        console.log(`> 🤖 Generating AI comparison summary for ${comparisonProducts.length} products`)
        try {
          const productsForAI = comparisonProducts.map(p => truncateProductForAI(p, 1000))
          const combinedData = productsForAI.join('\n\n---\n\n')
          
          const comparisonCompletion = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
              {
                role: 'system',
                content: `You are an expert aerospace product consultant. Compare the following products and provide a detailed analysis.

PRODUCTS TO COMPARE:
${combinedData}

GUIDELINES:
- Start with a brief overview of what these products are
- Highlight KEY DIFFERENCES between the products (specifications, features, applications)
- Highlight SIMILARITIES between the products
- Mention specific technical details from the data
- Use bullet points for clarity
- Be concise but comprehensive
- Format with markdown for readability`
              },
              {
                role: 'user',
                content: `Compare these products: ${searchKeywords.join(' vs ')}`
              }
            ],
            temperature: 0.3,
            max_tokens: 1500
          })
          
          comparisonSummary = comparisonCompletion.choices[0].message.content || ''
          comparisonSummary = stripHtml(comparisonSummary)
          console.log(`> ✅ AI comparison summary generated`)
          
        } catch (error: any) {
          console.error('> ❌ Failed to generate comparison summary:', error.message)
          comparisonSummary = `Comparing ${comparisonProducts.length} products: ${comparisonProducts.map(p => p.sku || p.Product_Name || 'Unknown').join(', ')}`
        }
      }
      
      // Remove duplicates by SKU
      const uniqueProducts = Array.from(
        new Map(comparisonProducts.map(p => [p.sku?.toLowerCase(), p])).values()
      )
      
      console.log(`> ✅ Comparison ready: ${uniqueProducts.length} unique products`)
      
      const duration = ((Date.now() - startTime) / 1000).toFixed(1)
      console.log(` POST /api/coatings-smart-search 200 in ${duration}s`)
      console.log(`${'='.repeat(80)}\n`)
      
      return NextResponse.json({
        success: true,
        questionType: "comparison",
        products: uniqueProducts,
        summary: comparisonSummary,
        count: uniqueProducts.length,
        keywordCoverage: Array.from(productsByKeyword.keys()),
        message: `Comparing ${uniqueProducts.length} product(s): ${uniqueProducts.map(p => p.sku || p.Product_Name || 'Unknown').join(' vs ')}`
      })
    }
    
    // Handle analytical queries
    if (searchParams.questionType === "analytical") {
      console.log(`> 🤖 Analytical mode - generating AI insights`)
      
      const topProducts = rankedResults.slice(0, 10).map(p => cleanProductData(p))
      
      // Generate AI summary
      let aiSummary = ''
      try {
        const productsForAI = topProducts.map(p => truncateProductForAI(p, 1500))
        const combinedData = productsForAI.slice(0, 5).join('\n\n---\n\n')
        
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            {
              role: 'system',
              content: `You are an expert aerospace coatings consultant. Analyze the following product data and provide helpful insights.

PRODUCT DATA:
${combinedData}

GUIDELINES:
- Answer the user's question directly and concisely
- Highlight key product features and specifications
- Provide recommendations when appropriate
- Use bullet points for clarity
- Be technical but accessible
- Format with markdown for readability`
            },
            {
              role: 'user',
              content: query
            }
          ],
          temperature: 0.3,
          max_tokens: 1000
        })
        
        aiSummary = completion.choices[0].message.content || ''
        aiSummary = stripHtml(aiSummary)
        console.log(`> ✅ AI summary generated`)
        
      } catch (error: any) {
        console.error('> ❌ Failed to generate AI summary:', error.message)
        aiSummary = `Found ${topProducts.length} relevant products. Showing top results.`
      }
      
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
        message: `Found ${rankedResults.length} product(s), showing top ${topProducts.length} with AI analysis`
      })
    }
    
    // Handle lookup queries (default)
    console.log(`> 📋 Lookup mode - returning product list`)
    const cleanedResults = rankedResults.slice(0, 50).map(p => cleanProductData(p))
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(` POST /api/coatings-smart-search 200 in ${duration}s`)
    console.log(`${'='.repeat(80)}\n`)
    
    return NextResponse.json({
      success: true,
      questionType: "lookup",
      products: cleanedResults,
      count: cleanedResults.length,
      totalFound: rankedResults.length,
      message: `Found ${rankedResults.length} product(s), showing top ${cleanedResults.length}`
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
