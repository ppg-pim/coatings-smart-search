import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import OpenAI from 'openai'

export const maxDuration = 300

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

type ProductRecord = Record<string, any>

let filterOptionsCache: {
  data: any | null
  timestamp: number
} = {
  data: null,
  timestamp: 0
}

const CACHE_DURATION = 1000 * 60 * 60
const BATCH_SIZE = 1000
const MAX_PRODUCTS_FOR_AI = 20
const MAX_TOTAL_FETCH = 100000
const EARLY_TERMINATION_THRESHOLD = 1000

// ============================================
// HELPER FUNCTIONS
// ============================================

function stripHtml(html: string): string {
  if (typeof html !== 'string') return html
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&deg;/g, '°')
    .replace(/&reg;/g, '®')
    .replace(/&copy;/g, '©')
    .replace(/&trade;/g, '™')
    .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
    .trim()
}

function cleanProductData(product: ProductRecord): ProductRecord {
  const cleaned: ProductRecord = {}
  const seen = new Set<string>()
  const excludeFields = ['embedding', 'all_attributes']
  
  Object.keys(product).forEach(key => {
    const lowerKey = key.toLowerCase()
    if (seen.has(lowerKey) || excludeFields.includes(key)) return
    seen.add(lowerKey)
    
    const value = product[key]
    if (value === null || value === undefined || value === '') return
    
    if (typeof value === 'string') {
      const cleanedValue = stripHtml(value)
      if (cleanedValue) {
        cleaned[key] = cleanedValue
      }
    } else {
      cleaned[key] = value
    }
  })
  
  return cleaned
}

function productMatchesKeywords(product: ProductRecord, keywords: string[], requireAll: boolean = true, debugMode: boolean = false): boolean {
  const fieldValues: Record<string, string> = {}
  
  Object.keys(product).forEach(key => {
    const value = product[key]
    if (value && typeof value === 'string') {
      fieldValues[key] = value.toLowerCase()
    }
  })
  
  const searchableText = Object.values(fieldValues).join(' ')
  
  if (debugMode) {
    console.log('\n🔍 DEBUG: Sample product structure:')
    console.log('Available fields with values (first 20):')
    Object.entries(fieldValues).slice(0, 20).forEach(([field, value]) => {
      console.log(`  - ${field}: ${value.substring(0, 100)}${value.length > 100 ? '...' : ''}`)
    })
    console.log(`\nTotal fields: ${Object.keys(fieldValues).length}`)
    console.log(`Searchable text length: ${searchableText.length} chars`)
    console.log(`Checking keywords: ${keywords.join(', ')}`)
  }
  
  if (requireAll) {
    const matches = keywords.every(keyword => {
      const lowerKeyword = keyword.toLowerCase()
      const found = searchableText.includes(lowerKeyword)
      if (debugMode) {
        console.log(`  ${found ? '✅' : '❌'} Keyword "${keyword}" ${found ? 'FOUND' : 'NOT found'}`)
      }
      return found
    })
    
    if (debugMode) {
      console.log(`\nResult: ${matches ? '✅ MATCH' : '❌ NO MATCH'}\n`)
    }
    
    return matches
  } else {
    return keywords.some(keyword => {
      const lowerKeyword = keyword.toLowerCase()
      return searchableText.includes(lowerKeyword)
    })
  }
}

function scoreProductRelevance(product: ProductRecord, keywords: string[]): number {
  let score = 0
  let matchedKeywords = 0
  
  keywords.forEach(keyword => {
    const lowerKeyword = keyword.toLowerCase()
    let keywordMatched = false
    
    Object.entries(product).forEach(([key, value]) => {
      if (value && typeof value === 'string') {
        const lowerValue = value.toLowerCase()
        if (lowerValue.includes(lowerKeyword)) {
          keywordMatched = true
          
          const lowerKey = key.toLowerCase()
          if (lowerKey.includes('sku')) {
            score += 50
          } else if (lowerKey.includes('name') || lowerKey.includes('title')) {
            score += 40
          } else if (lowerKey.includes('family')) {
            score += 35
          } else if (lowerKey.includes('type')) {
            score += 35
          } else if (lowerKey.includes('model')) {
            score += 30
          } else if (lowerKey.includes('description')) {
            score += 10
          } else {
            score += 5
          }
        }
      }
    })
    
    if (keywordMatched) {
      matchedKeywords++
    }
  })
  
  if (keywords.length > 1) {
    const multiMatchBonus = (matchedKeywords / keywords.length) * 100
    score += multiMatchBonus
    
    if (matchedKeywords === keywords.length) {
      score += 200
    }
  }
  
  return score
}

function extractEssentialFields(product: ProductRecord): ProductRecord {
  const essentialFields = [
    'sku',
    'family',
    'Product_Name',
    'Product_Description',
    'Product_Type',
    'Product_Model',
    'Brand',
    'Bullet_Points',
    'Application',
    'Color',
    'Specification',
    'Market',
    'Service_Temperature',
    'Shelf_Life',
    'Flash_Point',
    'VOC_Mixed',
    'Theoretical_Coverage',
    'Dry_Film_Thickness',
    'Compatible_Aircrafts'
  ]
  
  const extracted: ProductRecord = {}
  
  essentialFields.forEach(field => {
    if (product[field] && product[field] !== '') {
      extracted[field] = product[field]
    }
  })
  
  return extracted
}

function truncateProductForAI(product: ProductRecord, maxLength: number = 1000): string {
  const essential = extractEssentialFields(product)
  let result = JSON.stringify(essential, null, 2)
  
  if (result.length > maxLength) {
    Object.keys(essential).forEach(key => {
      if (typeof essential[key] === 'string' && essential[key].length > 200) {
        essential[key] = essential[key].substring(0, 200) + '...'
      }
    })
    result = JSON.stringify(essential, null, 2)
  }
  
  return result
}

// NEW: Fast database search for analytical queries
async function fastDatabaseSearch(keywords: string[], limit: number = 50): Promise<ProductRecord[]> {
  console.log(`⚡ Using FAST database search for: ${keywords.join(', ')}`)
  const startTime = Date.now()
  
  // Build OR condition for multiple fields
  const searchTerm = keywords.join(' ')
  
  // Search across key fields using ilike (case-insensitive)
  const { data, error } = await supabase
    .from('coatings')
    .select('*')
    .or(`Product_Name.ilike.%${searchTerm}%,Product_Description.ilike.%${searchTerm}%,Bullet_Points.ilike.%${searchTerm}%,Application.ilike.%${searchTerm}%,family.ilike.%${searchTerm}%,Product_Type.ilike.%${searchTerm}%`)
    .limit(limit)
  
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2)
  
  if (error) {
    console.error('❌ Fast database search error:', error)
    return []
  }
  
  if (data && data.length > 0) {
    console.log(`✅ Fast search found ${data.length} products in ${elapsed}s (vs 60s+ for full scan!)`)
    return data
  }
  
  console.log(`❌ Fast search found no results in ${elapsed}s`)
  return []
}

async function tryDirectMultiSKULookup(skus: string[]): Promise<ProductRecord[]> {
  console.log(`🎯 Trying direct multi-SKU lookup for: ${skus.join(', ')}`)
  
  const orConditions = skus.map(sku => `sku.ilike.${sku}`).join(',')
  
  const { data, error } = await supabase
    .from('coatings')
    .select('*')
    .or(orConditions)
  
  if (error) {
    console.error('❌ Direct multi-SKU lookup error:', error)
    return []
  }
  
  if (data && data.length > 0) {
    console.log(`✅ Found ${data.length} exact SKU matches!`)
    return data
  }
  
  console.log(`❌ No exact SKU matches found`)
  return []
}

async function tryDirectSKULookup(sku: string): Promise<ProductRecord | null> {
  console.log(`🎯 Trying direct SKU lookup for: ${sku}`)
  
  const { data, error } = await supabase
    .from('coatings')
    .select('*')
    .ilike('sku', sku)
    .limit(1)
  
  if (error) {
    console.error('❌ Direct SKU lookup error:', error)
    return null
  }
  
  if (data && data.length > 0) {
    console.log(`✅ Found exact SKU match!`)
    return data[0]
  }
  
  console.log(`❌ No exact SKU match found`)
  return null
}

async function tryFuzzySearch(keyword: string): Promise<ProductRecord[]> {
  console.log(`🔍 Trying fuzzy search for: ${keyword}`)
  
  const { data, error } = await supabase
    .from('coatings')
    .select('*')
    .or(`sku.ilike.%${keyword}%,Product_Name.ilike.%${keyword}%,family.ilike.%${keyword}%`)
    .limit(20)
  
  if (error) {
    console.error('❌ Fuzzy search error:', error)
    return []
  }
  
  if (data && data.length > 0) {
    console.log(`✅ Found ${data.length} fuzzy matches`)
    return data
  }
  
  console.log(`❌ No fuzzy matches found`)
  return []
}

async function searchAllTables(keyword: string): Promise<{ table: string, products: ProductRecord[] }[]> {
  console.log(`🌐 Searching across all product tables for: ${keyword}`)
  
  const tables = ['coatings', 'sealants', 'chemicals', 'cleaners']
  const results: { table: string, products: ProductRecord[] }[] = []
  
  for (const table of tables) {
    try {
      const { data, error } = await supabase
        .from(table)
        .select('*')
        .or(`sku.ilike.%${keyword}%,Product_Name.ilike.%${keyword}%`)
        .limit(5)
      
      if (!error && data && data.length > 0) {
        console.log(`  ✅ Found ${data.length} results in ${table}`)
        results.push({ table, products: data })
      }
    } catch (err) {
      console.log(`  ⚠️ Table ${table} might not exist, skipping...`)
    }
  }
  
  return results
}

async function fetchProductsInBatches(
  filters: any,
  columns: string[],
  searchKeywords: string[],
  requireAllKeywords: boolean,
  maxRecords: number = MAX_TOTAL_FETCH
): Promise<ProductRecord[]> {
  console.log(`🔄 Starting batch fetch (max ${maxRecords} records, batch size: ${BATCH_SIZE})...`)
  console.log(`🔑 Searching for keywords: ${searchKeywords.join(', ')} (require all: ${requireAllKeywords})`)
  
  if (searchKeywords.length >= 2 && searchKeywords.every(k => k.length > 5)) {
    console.log('🚀 Detected multiple SKUs - using fast direct lookup!')
    const directMatches = await tryDirectMultiSKULookup(searchKeywords)
    if (directMatches.length > 0) {
      return directMatches
    }
  }
  
  if (searchKeywords.length === 1 && searchKeywords[0].length > 5) {
    const directMatch = await tryDirectSKULookup(searchKeywords[0])
    if (directMatch) {
      return [directMatch]
    }
  }
  
  let allMatchingProducts: ProductRecord[] = []
  let offset = 0
  let hasMore = true
  let batchCount = 0
  let totalProcessed = 0
  const startTime = Date.now()
  let debugLogged = false
  
  while (hasMore && totalProcessed < maxRecords) {
    batchCount++
    const batchStartTime = Date.now()
    
    console.log(`📦 Fetching batch ${batchCount} (offset: ${offset}, limit: ${BATCH_SIZE})...`)
    
    let batchQuery = supabase
      .from('coatings')
      .select('*')
      .range(offset, offset + BATCH_SIZE - 1)
    
    const { data: batch, error } = await batchQuery
    
    if (error) {
      console.error(`❌ Error fetching batch ${batchCount}:`, error)
      throw new Error(`Database error: ${error.message}`)
    }
    
    if (!batch || batch.length === 0) {
      hasMore = false
      console.log(`✅ No more records found at offset ${offset}`)
      break
    }
    
    totalProcessed += batch.length
    const batchFetchTime = Date.now() - batchStartTime
    console.log(`   ✓ Fetched ${batch.length} records in ${batchFetchTime}ms`)
    
    let filteredBatch = batch
    
    if (searchKeywords.length > 0) {
      const beforeFilter = filteredBatch.length
      const filterStartTime = Date.now()
      
      const shouldDebug = !debugLogged && batchCount === 1
      
      filteredBatch = filteredBatch.filter((product: ProductRecord, index: number) => {
        const matches = productMatchesKeywords(product, searchKeywords, requireAllKeywords, shouldDebug && index === 0)
        return matches
      })
      
      debugLogged = true
      
      const filterTime = Date.now() - filterStartTime
      console.log(`   🔍 Keyword filter: ${beforeFilter} → ${filteredBatch.length} products (${filterTime}ms)`)
    }
    
    if (filters && (filters.family || filters.productType || filters.productModel)) {
      const beforeUserFilter = filteredBatch.length
      filteredBatch = filterProductsInMemory(filteredBatch, filters)
      console.log(`   🎯 User filter: ${beforeUserFilter} → ${filteredBatch.length} products`)
    }
    
    allMatchingProducts = allMatchingProducts.concat(filteredBatch)
    
    const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`   📊 Total matching: ${allMatchingProducts.length} | Processed: ${totalProcessed} | Time: ${elapsedTime}s`)
    
    if (allMatchingProducts.length >= EARLY_TERMINATION_THRESHOLD) {
      console.log(`✅ Early termination: Found ${allMatchingProducts.length} matches`)
      hasMore = false
      break
    }
    
    offset += BATCH_SIZE
    
    if (batch.length < BATCH_SIZE) {
      console.log(`✅ Reached end of data (batch returned ${batch.length} < ${BATCH_SIZE})`)
      hasMore = false
    }
    
    if (offset >= maxRecords) {
      console.log(`⚠️ Reached maximum offset (${maxRecords})`)
      hasMore = false
    }
  }
  
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`✅ Batch fetch complete: ${allMatchingProducts.length} matching products from ${batchCount} batches (${totalProcessed} total processed) in ${totalTime}s`)
  
  return allMatchingProducts
}

function filterProductsInMemory(products: any[], filters: any): any[] {
  if (!filters) return products

  return products.filter(product => {
    let matches = true

    if (filters.family && product.family !== filters.family) {
      matches = false
    }

    if (filters.productType && product.Product_Type !== filters.productType) {
      matches = false
    }

    if (filters.productModel && product.Product_Model !== filters.productModel) {
      matches = false
    }

    return matches
  })
}

async function generateAISummary(query: string, products: ProductRecord[], searchKeywords: string[] = []): Promise<string> {
  try {
    let productsToAnalyze = products.slice(0, 10)
    
    const productsData = productsToAnalyze.map(p => truncateProductForAI(p, 800))
    const combinedData = productsData.join('\n\n---\n\n')
    
    const estimatedTokens = combinedData.length / 4
    console.log(`🤖 Generating AI summary from ${productsToAnalyze.length} products (${estimatedTokens.toFixed(0)} estimated tokens, total found: ${products.length})`)
    
    if (estimatedTokens > 15000) {
      console.warn(`⚠️ Data still too large (${estimatedTokens} tokens), reducing to top 5 products`)
      productsToAnalyze = products.slice(0, 5)
      const reducedData = productsToAnalyze.map(p => truncateProductForAI(p, 600))
      return await generateAISummaryWithData(query, reducedData.join('\n\n---\n\n'), products.length)
    }
    
    return await generateAISummaryWithData(query, combinedData, products.length)
    
  } catch (error: any) {
    console.error('❌ AI summary generation error:', error.message)
    return generateBasicSummary(products, searchKeywords)
  }
}

async function generateAISummaryWithData(query: string, productData: string, totalCount: number): Promise<string> {
  const summaryCompletion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `You are an expert aerospace product consultant. Analyze the product data and provide a comprehensive answer.

PRODUCT DATA (showing sample from ${totalCount} total products):
${productData}

GUIDELINES:
- Answer the user's question directly and comprehensively
- Extract key benefits, features, and specifications from the Bullet_Points and Product_Description fields
- Use specific technical details from the data
- Format with clear sections and bullet points
- Be conversational but professional
- Mention the total number of products found (${totalCount})`
      },
      {
        role: 'user',
        content: query
      }
    ],
    temperature: 0.3,
    max_tokens: 1500
  })
  
  let summary = summaryCompletion.choices[0].message.content || 'Unable to generate summary'
  summary = stripHtml(summary)
  
  return summary
}

function generateBasicSummary(products: ProductRecord[], searchKeywords: string[]): string {
  const product = products[0]
  const sku = product.sku || 'Unknown'
  const family = product.family || 'Unknown'
  const brand = product.Brand || 'Unknown'
  const productType = product.Product_Type || 'product'
  
  let summary = `# ${sku}\n\n`
  summary += `**Family:** ${family} | **Brand:** ${brand} | **Type:** ${productType}\n\n`
  summary += `Found ${products.length} matching product variant(s).\n\n`
  
  if (product.Bullet_Points) {
    summary += `## Key Features:\n\n`
    const bulletPoints = stripHtml(product.Bullet_Points)
    summary += bulletPoints + '\n\n'
  }
  
  if (product.Product_Description) {
    summary += `## Description:\n\n`
    const description = stripHtml(product.Product_Description)
    summary += description.substring(0, 500) + (description.length > 500 ? '...' : '') + '\n\n'
  }
  
  if (product.Application) {
    summary += `## Application:\n\n`
    const application = stripHtml(product.Application)
    summary += application.substring(0, 300) + (application.length > 300 ? '...' : '') + '\n\n'
  }
  
  return summary
}

// ============================================
// MAIN API HANDLER
// ============================================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { query, filters, getFilterOptions } = body

    if (query === '__GET_FILTER_OPTIONS__' || getFilterOptions === true) {
      console.log('📋 Loading filter options for coatings...')
      
      const now = Date.now()
      const cacheAge = now - filterOptionsCache.timestamp
      
      if (filterOptionsCache.data && cacheAge < CACHE_DURATION) {
        console.log(`✅ Returning cached filter options (age: ${Math.round(cacheAge / 1000)}s)`)
        return NextResponse.json(filterOptionsCache.data)
      }
      
      console.log('🔄 Cache miss or expired, fetching fresh filter data...')
      
      try {
        const { count: totalCount } = await supabase
          .from('coatings')
          .select('*', { count: 'exact', head: true })

        console.log(`📊 Total coatings in database: ${totalCount}`)

        const batchSize = 1000
        const totalBatches = Math.ceil((totalCount || 0) / batchSize)
        let allProducts: any[] = []

        console.log(`📦 Fetching ${totalBatches} batches of ${batchSize} records...`)

        for (let i = 0; i < totalBatches; i++) {
          const offset = i * batchSize
          const { data: batch, error } = await supabase
            .from('coatings')
            .select('family, Product_Type, Product_Model, Brand')
            .range(offset, offset + batchSize - 1)

          if (error) {
            console.error(`❌ Error fetching batch ${i + 1}:`, error)
            throw new Error(`Database error: ${error.message}`)
          }

          if (batch && batch.length > 0) {
            allProducts = allProducts.concat(batch)
            console.log(`   ✓ Batch ${i + 1}/${totalBatches} fetched (${batch.length} records, total: ${allProducts.length})`)
          }
          
          if (!batch || batch.length < batchSize) {
            console.log(`   ✅ Reached end of data at batch ${i + 1}`)
            break
          }
        }

        console.log(`✅ Fetched ${allProducts.length} coating records`)

        const families = new Set<string>()
        const productTypes = new Set<string>()
        const productModels = new Set<string>()

        const addIfValid = (set: Set<string>, value: any) => {
          if (value !== null && value !== undefined && value !== '') {
            const strValue = String(value).trim()
            if (strValue && 
                strValue.toLowerCase() !== 'null' && 
                strValue.toLowerCase() !== 'undefined' &&
                strValue.toLowerCase() !== 'n/a' &&
                strValue !== '-') {
              set.add(strValue)
            }
          }
        }

        allProducts.forEach((product: any) => {
          addIfValid(families, product.family)
          addIfValid(productTypes, product.Product_Type)
          addIfValid(productModels, product.Product_Model)
        })

        const familiesArray = Array.from(families).sort()
        const productTypesArray = Array.from(productTypes).sort()
        const productModelsArray = Array.from(productModels).sort()

        console.log(`✅ Filter options extracted:`)
        console.log(`   - Families: ${familiesArray.length}`)
        console.log(`   - Product Types: ${productTypesArray.length}`)
        console.log(`   - Product Models: ${productModelsArray.length}`)

        const responseData = {
          success: true,
          filterOptions: {
            families: familiesArray,
            productTypes: productTypesArray,
            productModels: productModelsArray
          },
          stats: {
            totalRecords: allProducts.length,
            databaseTotal: totalCount,
            familiesCount: familiesArray.length,
            typesCount: productTypesArray.length,
            modelsCount: productModelsArray.length
          }
        }

        filterOptionsCache = {
          data: responseData,
          timestamp: now
        }
        
        console.log('💾 Filter options cached for 1 hour')

        return NextResponse.json(responseData)
      } catch (error: any) {
        console.error('❌ Error loading filter options:', error)
        return NextResponse.json({
          success: false,
          filterOptions: { 
            families: [], 
            productTypes: [], 
            productModels: [] 
          },
          error: error.message
        })
      }
    }

    // ============================================
    // REGULAR SEARCH FLOW
    // ============================================
    if (!query) {
      return NextResponse.json(
        { error: 'Query is required' },
        { status: 400 }
      )
    }

    console.log('🔍 User query:', query)
    console.log('🎯 Applied filters:', filters)

    const { data: sampleData, error: schemaError } = await supabase
      .from('coatings')
      .select('*')
      .limit(3)

    if (schemaError) {
      throw new Error(`Schema error: ${schemaError.message}`)
    }

    const columns = sampleData && sampleData.length > 0 
      ? Object.keys(sampleData[0]) 
      : []

    console.log('📊 Available columns:', columns.length)
    
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a smart search assistant for aerospace products. Analyze queries and extract search parameters.

TASK: Determine the question type and extract keywords.

QUESTION TYPES:
1. "comparison" - Comparing 2+ products (keywords: "compare", "vs", "versus", "difference between")
2. "analytical" - Needs explanation ("what is", "benefits of", "tell me about", "why use")
3. "list" - Simple product search

KEYWORD EXTRACTION:
- Extract product identifiers (SKUs, codes, family names)
- For comparisons: extract ALL product SKUs/names being compared
- Remove filler words
- Keep product-specific terms

RESPONSE FORMAT (JSON):
{
"questionType": "comparison" | "analytical" | "list",
"searchKeywords": ["keyword1", "keyword2"],
"requireAllKeywords": false,
"useBatchFetch": true
}

EXAMPLES:

Query: "compare DE02GN084XZZY22K to DE02GN084XZZX22K"
Response:
{
"questionType": "comparison",
"searchKeywords": ["DE02GN084XZZY22K", "DE02GN084XZZX22K"],
"requireAllKeywords": false,
"useBatchFetch": true
}

Query: "what is chrome free"
Response:
{
"questionType": "analytical",
"searchKeywords": ["chrome free"],
"requireAllKeywords": false,
"useBatchFetch": false
}

Query: "show me epoxy primers"
Response:
{
"questionType": "list",
"searchKeywords": ["epoxy", "primer"],
"requireAllKeywords": true,
"useBatchFetch": true
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

    let searchParams
    try {
      searchParams = JSON.parse(completion.choices[0].message.content || '{"questionType": "list", "searchKeywords": [], "requireAllKeywords": false, "useBatchFetch": true}')
    } catch (parseError) {
      console.error('❌ Failed to parse GPT response:', completion.choices[0].message.content)
      searchParams = { questionType: "list", searchKeywords: [], requireAllKeywords: false, useBatchFetch: true }
    }

    console.log('📋 Parsed search params:', JSON.stringify(searchParams, null, 2))

    const searchKeywords = searchParams.searchKeywords || []
    console.log(`🔑 Search keywords: ${searchKeywords.join(', ')}`)
    console.log(`❓ Question type: ${searchParams.questionType}`)

    // NEW: Use fast database search for analytical questions
    let data: ProductRecord[]
    
    if (searchParams.questionType === "analytical" && searchKeywords.length > 0) {
      console.log('⚡ ANALYTICAL QUERY - Using fast database search instead of full scan!')
      data = await fastDatabaseSearch(searchKeywords, 100)
      
      if (data.length === 0) {
        console.log('⚠️ Fast search returned no results, falling back to batch fetch...')
        data = await fetchProductsInBatches(
          filters,
          columns,
          searchKeywords,
          searchParams.requireAllKeywords || false,
          MAX_TOTAL_FETCH
        )
      }
    } else {
      data = await fetchProductsInBatches(
        filters,
        columns,
        searchKeywords,
        searchParams.requireAllKeywords || false,
        MAX_TOTAL_FETCH
      )
    }
    
    console.log(`✅ Search returned ${data.length} matching products`)

    if (data.length === 0 && searchKeywords.length > 0) {
      console.log(`⚠️ No exact matches found, trying fallback strategies...`)
      
      const fuzzyResults = await tryFuzzySearch(searchKeywords[0])
      
      if (fuzzyResults.length > 0) {
        console.log(`✅ Fuzzy search found ${fuzzyResults.length} similar products`)
        
        const cleanedResults = fuzzyResults.map((product: ProductRecord) => cleanProductData(product))
        
        return NextResponse.json({
          success: true,
          questionType: "list",
          results: cleanedResults,
          count: cleanedResults.length,
          message: `No exact match found for "${searchKeywords[0]}". Showing ${cleanedResults.length} similar product(s).`,
          searchType: "fuzzy"
        })
      }
      
      const multiTableResults = await searchAllTables(searchKeywords[0])
      
      if (multiTableResults.length > 0) {
        const allProducts = multiTableResults.flatMap(r => r.products.map(p => ({ ...p, _sourceTable: r.table })))
        const cleanedResults = allProducts.map((product: ProductRecord) => cleanProductData(product))
        
        const tableNames = multiTableResults.map(r => r.table).join(', ')
        
        return NextResponse.json({
          success: true,
          questionType: "list",
          results: cleanedResults,
          count: cleanedResults.length,
          message: `Product not found in coatings. Found ${cleanedResults.length} result(s) in: ${tableNames}`,
          searchType: "multi-table",
          tables: multiTableResults.map(r => ({ table: r.table, count: r.products.length }))
        })
      }
      
      return NextResponse.json({
        success: true,
        questionType: "list",
        results: [],
        count: 0,
        message: `No products found matching "${searchKeywords[0]}" in any category. Please check the SKU or try a different search term.`,
        searchType: "not-found"
      })
    }

    const cleanedResults = data.map((product: ProductRecord) => cleanProductData(product))

    interface ScoredProduct {
      product: ProductRecord;
      score: number;
    }
    
    const scoredProducts: ScoredProduct[] = cleanedResults.map((product: ProductRecord) => ({
      product,
      score: scoreProductRelevance(product, searchKeywords)
    }))
    
    scoredProducts.sort((a: ScoredProduct, b: ScoredProduct) => b.score - a.score)
    
    console.log(`🎯 Top 5 results:`)
    scoredProducts.slice(0, 5).forEach((item: ScoredProduct, index: number) => {
      const sku = item.product.sku || 'N/A'
      const family = item.product.family || 'N/A'
      console.log(`   ${index + 1}. SKU: ${sku} (Family: ${family}) - Score: ${item.score}`)
    })
    
    const rankedResults = scoredProducts.map((item: ScoredProduct) => item.product)

    if (searchParams.questionType === "comparison") {
      console.log(`📊 Comparison mode - returning products for side-by-side view`)
      
      const uniqueProducts = Array.from(
        new Map(rankedResults.map(p => [p.sku?.toLowerCase(), p])).values()
      )
      
      return NextResponse.json({
        success: true,
        questionType: "comparison",
        products: uniqueProducts.slice(0, 10),
        count: uniqueProducts.length,
        message: `Comparing ${Math.min(uniqueProducts.length, 10)} product(s)`
      })
    }

    if (searchParams.questionType === "analytical") {
      console.log(`🤖 Analytical mode - generating AI summary`)
      
      const aiSummary = await generateAISummary(query, rankedResults, searchKeywords)
      
      return NextResponse.json({
        success: true,
        questionType: "analytical",
        summary: aiSummary,
        results: rankedResults.slice(0, 20),
        count: rankedResults.length,
        message: `Analysis based on ${rankedResults.length} product(s)`
      })
    }

    return NextResponse.json({
      success: true,
      questionType: "list",
      results: rankedResults,
      count: rankedResults.length
    })

  } catch (error: any) {
    console.error('❌ Smart search error:', error)
    
    return NextResponse.json(
      { 
        success: false,
        error: error.message || 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error.toString() : undefined
      },
      { status: 500 }
    )
  }
}