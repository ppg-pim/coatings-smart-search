import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const openaiApiKey = process.env.OPENAI_API_KEY!

const supabase = createClient(supabaseUrl, supabaseKey)
const openai = new OpenAI({ apiKey: openaiApiKey })

// ============================================================================
// TYPES & CONSTANTS
// ============================================================================

type ProductRecord = Record<string, any>

interface AIQueryPlan {
  intent: 'comparison' | 'lookup' | 'list' | 'count' | 'analytical'
  searchTerms: string[]
  filters?: {
    family?: string
    productType?: string
    productModel?: string
  }
  requiresMultipleProducts: boolean
  explanation: string
}

interface FilterCache {
  families: string[]
  productTypes: string[]
  productModels: string[]
  timestamp: number
  ttl: number
}

interface QueryAnalysis {
  isSingleWord: boolean
  isMultiWord: boolean
  wordCount: number
  requiresAllWords: boolean
  searchStrategy: 'semantic-first' | 'keyword-first' | 'hybrid'
}

// 🎯 OPTIMIZED TOKEN LIMITS
const MAX_TOKENS = 30000
const MAX_INPUT_TOKENS = 20000
const MAX_DETAILED_PRODUCTS = 20
const MAX_SUMMARY_PRODUCTS = 100
const MAX_FIELD_LENGTH = 200

// 🎯 Semantic Search Configuration
const EMBEDDING_MODEL = 'text-embedding-3-small'
const SEMANTIC_SIMILARITY_THRESHOLD = 0.50
const SEMANTIC_SEARCH_LIMIT = 100

// 🎯 Cache for database schema
let schemaCache: string[] | null = null

// In-memory cache
let filterCache: FilterCache | null = null
const CACHE_TTL = 1000 * 60 * 60 * 24

// ============================================================================
// DATABASE UTILITIES
// ============================================================================

async function getDatabaseColumns(): Promise<string[]> {
  if (schemaCache) {
    return schemaCache
  }

  try {
    const { data, error } = await supabase
      .from('coatings')
      .select('*')
      .limit(1)

    if (error || !data || data.length === 0) {
      console.error('❌ Failed to get database schema')
      return ['sku', 'family', 'Product_Name', 'Product_Type', 'Product_Model', 'Product_Description']
    }

    const columns = Object.keys(data[0])
    schemaCache = columns
    console.log(`✅ Database columns detected: ${columns.length} fields`)

    return columns
  } catch (error) {
    console.error('❌ Error getting database columns:', error)
    return ['sku', 'family', 'Product_Name', 'Product_Type', 'Product_Model', 'Product_Description']
  }
}

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

// ============================================================================
// FILTER OPTIONS & CACHING
// ============================================================================

async function fetchAllDistinctValues(columnName: string): Promise<string[]> {
  console.log(`  📊 Fetching all distinct values for: ${columnName}`)

  const allValues = new Set<string>()
  let page = 0
  const pageSize = 1000
  let hasMore = true

  while (hasMore) {
    const from = page * pageSize
    const to = from + pageSize - 1

    try {
      const { data, error } = await supabase
        .from('coatings')
        .select(columnName)
        .not(columnName, 'is', null)
        .neq(columnName, '')
        .order(columnName)
        .range(from, to)

      if (error || !data || data.length === 0) break

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

      if (page > 100) break

    } catch (err) {
      console.error(`  ❌ Exception fetching ${columnName}:`, err)
      break
    }
  }

  const sortedValues = Array.from(allValues).sort()
  console.log(`  ✅ ${columnName}: ${sortedValues.length} unique values`)

  return sortedValues
}

async function getFilterOptions(forceRefresh: boolean = false): Promise<any> {
  if (!forceRefresh && filterCache) {
    const now = Date.now()
    const cacheAge = now - filterCache.timestamp

    if (cacheAge < filterCache.ttl) {
      return {
        success: true,
        cached: true,
        filterOptions: {
          families: filterCache.families,
          productTypes: filterCache.productTypes,
          productModels: filterCache.productModels
        }
      }
    }
  }

  try {
    const [families, types, models] = await Promise.all([
      fetchAllDistinctValues('family'),
      fetchAllDistinctValues('Product_Type'),
      fetchAllDistinctValues('Product_Model')
    ])

    filterCache = {
      families,
      productTypes: types,
      productModels: models,
      timestamp: Date.now(),
      ttl: CACHE_TTL
    }

    return {
      success: true,
      cached: false,
      filterOptions: {
        families,
        productTypes: types,
        productModels: models
      }
    }
  } catch (error: any) {
    console.error('❌ Error fetching filter options:', error)

    if (filterCache) {
      return {
        success: true,
        cached: true,
        expired: true,
        filterOptions: {
          families: filterCache.families,
          productTypes: filterCache.productTypes,
          productModels: filterCache.productModels
        }
      }
    }

    return {
      success: false,
      error: 'Failed to fetch filter options',
      filterOptions: { families: [], productTypes: [], productModels: [] }
    }
  }
}

// ============================================================================
// SEMANTIC SEARCH
// ============================================================================

async function generateEmbedding(text: string): Promise<number[]> {
  try {
    console.log(`🧠 Generating embedding for: "${text.substring(0, 50)}..."`)
    
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text,
    })
    
    console.log(`✅ Embedding generated (${response.data[0].embedding.length} dimensions)`)
    return response.data[0].embedding
  } catch (error) {
    console.error('❌ Embedding generation failed:', error)
    return []
  }
}

async function executeSemanticSearch(
  queryText: string,
  appliedFilters: any,
  limit: number = SEMANTIC_SEARCH_LIMIT
): Promise<ProductRecord[]> {
  console.log(`🧠 Executing semantic search for: "${queryText}"`)

  try {
    const queryEmbedding = await generateEmbedding(queryText)

    if (queryEmbedding.length === 0) {
      console.log('⚠️ Semantic search failed, no embedding generated')
      return []
    }

    console.log(`✅ Query embedding generated: ${queryEmbedding.length} dimensions`)

    const columns = await getDatabaseColumns()
    if (!columns.includes('embedding')) {
      console.log('⚠️ Semantic search unavailable: embedding column not found')
      return []
    }

    const thresholds = [0.50, 0.40, 0.30, 0.20]

    for (const threshold of thresholds) {
      console.log(`🔍 Trying semantic search with threshold: ${threshold}`)

      try {
        const embeddingString = `[${queryEmbedding.join(',')}]`
        
        console.log(`   📊 Embedding format: string with ${queryEmbedding.length} values`)

        const { data, error } = await supabase.rpc('match_coatings', {
          query_embedding: embeddingString,
          match_threshold: threshold,
          match_count: limit
        })

        // 🎯 Debug logging
        console.log(`   🔍 RPC Response:`)
        console.log(`      - data type: ${Array.isArray(data) ? 'array' : typeof data}`)
        console.log(`      - data length: ${data?.length || 0}`)
        console.log(`      - error: ${error ? JSON.stringify(error) : 'none'}`)

        if (data && data.length > 0) {
          console.log(`      - first result:`, {
            sku: data[0].sku,
            type: data[0].Product_Type,
            similarity: data[0].similarity
          })
        }

        if (error) {
          console.error(`❌ Semantic search error at threshold ${threshold}:`, error)
          
          if (error.message?.includes('function match_coatings') || error.code === '42883') {
            console.error('❌ RPC function "match_coatings" does not exist!')
            return []
          }
          
          continue
        }

        if (!data || !Array.isArray(data) || data.length === 0) {
          console.log(`⚠️ Semantic search returned 0 results at threshold ${threshold}`)
          continue
        }

        console.log(`✅ Semantic search found ${data.length} products at threshold ${threshold}`)
        console.log(`   Top 5 similarities:`, data.slice(0, 5).map((d: any) => 
          `${d.similarity?.toFixed(3)} - ${d.Product_Type || 'N/A'}`
        ).join(', '))

        let filtered = data

        if (appliedFilters.family) {
          const beforeCount = filtered.length
          filtered = filtered.filter((p: any) => p.family === appliedFilters.family)
          console.log(`   Family filter "${appliedFilters.family}": ${beforeCount} → ${filtered.length} products`)
        }

        if (appliedFilters.productType) {
          const beforeCount = filtered.length
          filtered = filtered.filter((p: any) => p.Product_Type === appliedFilters.productType)
          console.log(`   Type filter "${appliedFilters.productType}": ${beforeCount} → ${filtered.length} products`)
        }

        if (appliedFilters.productModel) {
          const beforeCount = filtered.length
          filtered = filtered.filter((p: any) => p.Product_Model === appliedFilters.productModel)
          console.log(`   Model filter "${appliedFilters.productModel}": ${beforeCount} → ${filtered.length} products`)
        }

        if (filtered.length > 0) {
          console.log(`✅ Returning ${filtered.length} filtered results`)
          return filtered
        }

        console.log(`⚠️ All ${data.length} results filtered out by applied filters`)
      } catch (rpcError: any) {
        console.error(`❌ RPC call failed at threshold ${threshold}:`, rpcError)
        continue
      }
    }

    console.log('⚠️ Semantic search exhausted all thresholds')
    return []

  } catch (error: any) {
    console.error('❌ Semantic search failed with exception:', error)
    return []
  }
}

// ============================================================================
// AI QUERY PLANNING
// ============================================================================

async function planQuery(userQuery: string, appliedFilters: any): Promise<AIQueryPlan> {
  console.log(`🤖 AI analyzing query: "${userQuery}"`)

  const systemPrompt = `Analyze user query and return JSON:
{
  "intent": "comparison|lookup|list|count|analytical",
  "searchTerms": ["term1", "term2"],
  "filters": {"productType": "optional", "productModel": "optional", "family": "optional"},
  "requiresMultipleProducts": true/false,
  "explanation": "brief explanation"
}

Intent types:
- comparison: Compare 2+ products
- lookup: Info about specific product(s)
- list: All products matching criteria
- count: How many products
- analytical: Recommendations/advice

IMPORTANT: For SKU comparisons, keep SKUs as complete search terms (e.g., ["8211FCLEARCAX22K", "8211FCLEARCAY22K"])`

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Query: "${userQuery}"\nFilters: ${JSON.stringify(appliedFilters)}` }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' }
    })

    const plan = JSON.parse(completion.choices[0].message.content || '{}') as AIQueryPlan
    console.log(`✅ AI Query Plan:`, plan)
    return plan
  } catch (error) {
    console.error('❌ AI planning failed:', error)
    return {
      intent: 'lookup',
      searchTerms: [userQuery],
      requiresMultipleProducts: false,
      explanation: 'Fallback'
    }
  }
}

// ============================================================================
// SMART SEARCH LOGIC
// ============================================================================

function detectSKUs(searchTerms: string[]): string[] {
  const skuPattern = /^[A-Z0-9]{8,}$/i
  return searchTerms.filter(term => {
    const cleanTerm = term.trim().replace(/[^A-Z0-9]/gi, '')
    return skuPattern.test(cleanTerm)
  })
}

function analyzeQuery(searchPhrase: string, searchWords: string[]): QueryAnalysis {
  const wordCount = searchWords.length
  const isSingleWord = wordCount === 1
  const isMultiWord = wordCount > 1

  const requiresAllWords = isMultiWord && wordCount === 2

  let searchStrategy: 'semantic-first' | 'keyword-first' | 'hybrid' = 'semantic-first'
  
  if (isSingleWord) {
    searchStrategy = 'keyword-first'
  } else if (wordCount >= 3) {
    searchStrategy = 'hybrid'
  }

  return {
    isSingleWord,
    isMultiWord,
    wordCount,
    requiresAllWords,
    searchStrategy
  }
}

async function executeSmartSearch(plan: AIQueryPlan, appliedFilters: any): Promise<ProductRecord[]> {
  console.log(`⚡ Executing smart search for: ${plan.searchTerms.join(', ')}`)

  const allResults: ProductRecord[] = []
  const seenIds = new Set<string>()

  const allColumns = await getDatabaseColumns()

  const searchPhrase = plan.searchTerms.join(' ')
  const searchWords = searchPhrase.toLowerCase().split(/\s+/).filter(w => w.length > 2)

  console.log(`🔍 Search phrase: "${searchPhrase}"`)
  console.log(`🔍 Search words: ${searchWords.join(', ')}`)

  const queryAnalysis = analyzeQuery(searchPhrase, searchWords)
  console.log(`🧠 Query Analysis:`, queryAnalysis)

  // ============================================================================
  // 🎯 STRATEGY 0: EXACT SKU MATCH
  // ============================================================================
  
  console.log(`\n🎯 STRATEGY 0: Exact SKU Match...`)
  const potentialSKUs = detectSKUs(plan.searchTerms)
  
  if (potentialSKUs.length > 0) {
    console.log(`  🏷️ Detected ${potentialSKUs.length} potential SKU(s): ${potentialSKUs.join(', ')}`)
    
    for (const skuTerm of potentialSKUs) {
      const cleanSKU = skuTerm.trim().toUpperCase()
      
      try {
        let query = supabase.from('coatings').select('*')

        if (appliedFilters.family) query = query.eq('family', appliedFilters.family)
        if (appliedFilters.productType) query = query.eq('Product_Type', appliedFilters.productType)
        if (appliedFilters.productModel) query = query.eq('Product_Model', appliedFilters.productModel)

        query = query.or(`sku.ilike.${cleanSKU},Product_Model.ilike.${cleanSKU},Product_Name.ilike.${cleanSKU}`)

        const { data, error } = await query.limit(10)

        if (data && data.length > 0) {
          console.log(`  ✅ Found ${data.length} exact SKU match(es)`)
          data.forEach((item: any) => {
            const id = item.sku || JSON.stringify(item)
            if (!seenIds.has(id)) {
              seenIds.add(id)
              allResults.push(item)
            }
          })
        }
      } catch (err) {
        console.error(`  ❌ SKU search failed:`, err)
      }
    }

    if (allResults.length > 0) {
      console.log(`✅ Returning ${allResults.length} exact SKU match(es)`)
      return allResults
    }
  }

  // ============================================================================
  // 🎯 STRATEGY 1: SEMANTIC SEARCH
  // ============================================================================
  
  if (queryAnalysis.searchStrategy === 'semantic-first' || queryAnalysis.searchStrategy === 'hybrid') {
    console.log(`\n🧠 STRATEGY 1: Semantic Search (${queryAnalysis.searchStrategy})...`)
    
    if (allColumns.includes('embedding')) {
      try {
        const semanticResults = await executeSemanticSearch(searchPhrase, appliedFilters, 100)

        if (semanticResults.length > 0) {
          console.log(`✅ Semantic search found ${semanticResults.length} products`)
          
          semanticResults.forEach((item: any) => {
            const id = item.sku || JSON.stringify(item)
            if (!seenIds.has(id)) {
              seenIds.add(id)
              allResults.push({ ...item, _source: 'semantic' })
            }
          })

          if (queryAnalysis.searchStrategy === 'semantic-first' && allResults.length >= 10) {
            console.log(`✅ Returning ${allResults.length} semantic search results`)
            return allResults
          }
        }
      } catch (err) {
        console.error(`❌ Semantic search failed:`, err)
      }
    } else {
      console.log(`⚠️ Semantic search unavailable (no embedding column)`)
    }
  }

  // ============================================================================
  // 🎯 STRATEGY 2: SMART KEYWORD SEARCH
  // ============================================================================
  
  console.log(`\n🔍 STRATEGY 2: Smart Keyword Search...`)

  try {
    let query = supabase.from('coatings').select('*')

    if (appliedFilters.family) query = query.eq('family', appliedFilters.family)
    if (appliedFilters.productType) query = query.eq('Product_Type', appliedFilters.productType)
    if (appliedFilters.productModel) query = query.eq('Product_Model', appliedFilters.productModel)

    const orConditions: string[] = []

    if (queryAnalysis.isSingleWord) {
      const word = searchWords[0]
      if (allColumns.includes('Product_Type')) orConditions.push(`Product_Type.ilike.%${word}%`)
      if (allColumns.includes('Product_Model')) orConditions.push(`Product_Model.ilike.%${word}%`)
      if (allColumns.includes('Product_Name')) orConditions.push(`Product_Name.ilike.%${word}%`)
      if (allColumns.includes('Product_Description')) orConditions.push(`Product_Description.ilike.%${word}%`)
    } else {
      if (allColumns.includes('Product_Type')) {
        orConditions.push(`Product_Type.ilike.%${searchPhrase}%`)
      }
      if (allColumns.includes('Product_Model')) {
        orConditions.push(`Product_Model.ilike.%${searchPhrase}%`)
      }
      if (allColumns.includes('Product_Name')) {
        orConditions.push(`Product_Name.ilike.%${searchPhrase}%`)
      }

      searchWords.forEach(word => {
        if (allColumns.includes('Product_Type')) orConditions.push(`Product_Type.ilike.%${word}%`)
        if (allColumns.includes('Product_Model')) orConditions.push(`Product_Model.ilike.%${word}%`)
      })
    }

    if (orConditions.length > 0) {
      query = query.or(orConditions.join(','))
    }

    const { data, error } = await query.limit(500)

    console.log(`📊 Keyword search: ${data?.length || 0} raw matches`)

    if (data && data.length > 0) {
      const scoredResults = data.map(item => {
        const productType = (item.Product_Type || '').toLowerCase()
        const productModel = (item.Product_Model || '').toLowerCase()
        const productName = (item.Product_Name || '').toLowerCase()
        const description = (item.Product_Description || '').toLowerCase()

        let score = 0
        const exactPhrase = searchPhrase.toLowerCase()

        if (productType === exactPhrase) score += 1000
        else if (productType.includes(exactPhrase)) score += 500

        if (productModel === exactPhrase) score += 800
        else if (productModel.includes(exactPhrase)) score += 400

        if (productName === exactPhrase) score += 600
        else if (productName.includes(exactPhrase)) score += 300

        const matchedWords = searchWords.filter(word =>
          productType.includes(word) || 
          productModel.includes(word) ||
          productName.includes(word) ||
          description.includes(word)
        )

        if (queryAnalysis.isSingleWord) {
          if (matchedWords.length === 0) return { item, score: 0 }
          
          searchWords.forEach(word => {
            if (productType.includes(word)) score += 50
            if (productModel.includes(word)) score += 40
            if (productName.includes(word)) score += 30
            if (description.includes(word)) score += 10
          })
        } else if (queryAnalysis.requiresAllWords) {
          if (matchedWords.length < searchWords.length) {
            return { item, score: 0 }
          }

          score += matchedWords.length * 50

          const allText = `${productType} ${productModel} ${productName}`
          if (allText.includes(exactPhrase)) {
            score += 200
          }
        } else {
          const minRequired = Math.max(2, Math.floor(searchWords.length * 0.6))
          if (matchedWords.length < minRequired) {
            return { item, score: 0 }
          }

          score += matchedWords.length * 30
        }

        return { item, score, matchedWords: matchedWords.length }
      })

      const minScore = queryAnalysis.isSingleWord ? 30 : 100
      const maxResults = queryAnalysis.isSingleWord ? 100 : 50

      const filtered = scoredResults
        .filter(r => r.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults)
        .map(r => ({ ...r.item, _source: 'keyword' }))

      console.log(`✅ Keyword search: ${filtered.length} relevant products (from ${data.length} raw)`)
      console.log(`📊 Top 5 scores:`, scoredResults
        .filter(r => r.score >= minScore)
        .slice(0, 5)
        .map(r => `${r.score}pts - ${r.item.Product_Type}`)
        .join(', ')
      )

      filtered.forEach((item: any) => {
        const id = item.sku || JSON.stringify(item)
        if (!seenIds.has(id)) {
          seenIds.add(id)
          allResults.push(item)
        }
      })

      if (allResults.length > 0) {
        console.log(`✅ Returning ${allResults.length} total results (semantic + keyword)`)
        return allResults
      }
    }
  } catch (err) {
    console.error(`❌ Keyword search failed:`, err)
  }

  console.log(`⚠️ No results found`)
  return []
}

// ============================================================================
// FORMATTING UTILITIES
// ============================================================================

async function prepareEssentialProductData(
  products: ProductRecord[],
  maxProducts: number = MAX_DETAILED_PRODUCTS
): Promise<string> {
  const allColumns = await getDatabaseColumns()

  const priorityFields = [
    'sku', 'family', 'Product_Name', 'Product_Type', 'Product_Model',
    'Product_Description', 'Application'
  ]

  const essentialFields = priorityFields.filter(field => allColumns.includes(field))
  const productsToSend = products.slice(0, maxProducts)

  return productsToSend.map((product, index) => {
    const lines: string[] = []
    lines.push(`\n${index + 1}. ${product.family || 'N/A'} | ${product.Product_Type || 'N/A'}`)

    essentialFields.forEach(field => {
      const value = product[field]
      if (value && typeof value === 'string' && value.trim() !== '') {
        const truncated = value.length > MAX_FIELD_LENGTH 
          ? value.substring(0, MAX_FIELD_LENGTH) + '...' 
          : value
        lines.push(`   ${field}: ${truncated}`)
      }
    })

    return lines.join('\n')
  }).join('\n')
}

function createFamilyGroupedSummary(products: ProductRecord[]): string {
  const familyGroups: Record<string, ProductRecord[]> = {}

  products.forEach(p => {
    const family = p.family || 'Unknown'
    if (!familyGroups[family]) {
      familyGroups[family] = []
    }
    familyGroups[family].push(p)
  })

  const lines: string[] = []
  lines.push(`Total Products: ${products.length}\n`)

  Object.entries(familyGroups).forEach(([family, items]) => {
    lines.push(`\n${family} (${items.length} products):`)
    
    const types = new Set(items.map(i => i.Product_Type).filter(Boolean))
    types.forEach(type => {
      const count = items.filter(i => i.Product_Type === type).length
      lines.push(`  - ${type}: ${count}`)
    })

    // Show top 3 examples
    const examples = items.slice(0, 3)
    if (examples.length > 0) {
      lines.push(`  Examples:`)
      examples.forEach(ex => {
        lines.push(`    • ${ex.Product_Type} (${ex.sku || 'N/A'})`)
      })
    }
  })

  return lines.join('\n')
}

// ============================================================================
// MAIN API HANDLER
// ============================================================================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { query, filters } = body

    console.log(`\n${'='.repeat(80)}`)
    console.log(`🔍 User query: ${query}`)
    console.log(`🎯 Applied filters:`, filters)

    // ============================================================================
    // 🎯 SPECIAL CASE: Filter Options Request
    // ============================================================================
    
    if (query === '__GET_FILTER_OPTIONS__') {
      console.log(`📋 Fetching filter options...`)
      
      try {
        const result = await getFilterOptions()
        
        if (result.success) {
          console.log(`✅ Filter options retrieved:`)
          console.log(`   👨‍👩‍👧‍👦 ${result.filterOptions.families.length} families`)
          console.log(`   📦 ${result.filterOptions.productTypes.length} product types`)
          console.log(`   🏷️  ${result.filterOptions.productModels.length} product models`)
          console.log(`   💾 Cached: ${result.cached ? 'Yes' : 'No'}`)
          
          return NextResponse.json({
            success: true,
            filterOptions: result.filterOptions,
            cached: result.cached
          })
        } else {
          console.error('❌ Failed to fetch filter options')
          return NextResponse.json(
            { error: 'Failed to fetch filter options' },
            { status: 500 }
          )
        }
      } catch (error: any) {
        console.error('❌ Exception fetching filter options:', error)
        return NextResponse.json(
          { error: error.message || 'Failed to fetch filter options' },
          { status: 500 }
        )
      }
    }

    // ============================================================================
    // 🎯 NORMAL SEARCH FLOW
    // ============================================================================

    const appliedFilters = {
      family: filters?.family || '',
      productType: filters?.productType || '',
      productModel: filters?.productModel || ''
    }

    // Step 1: AI Query Planning
    const plan = await planQuery(query, appliedFilters)
    console.log(`> 🎯 AI determined intent: ${plan.intent}`)
    console.log(`> 🔑 Search terms: ${plan.searchTerms.join(', ')}`)

    // Step 2: Execute Smart Search
    const products = await executeSmartSearch(plan, appliedFilters)
    console.log(`> ✅ Found ${products.length} products`)

    if (products.length === 0) {
      return NextResponse.json({
        success: true,
        answer: "I couldn't find any products matching your search. Please try:\n\n" +
                "- Using different keywords\n" +
                "- Removing some filters\n" +
                "- Checking spelling\n" +
                "- Being more general (e.g., 'primer' instead of 'epoxy primer for aluminum')",
        products: [],
        intent: plan.intent,
        searchTerms: plan.searchTerms
      })
    }

    // Step 3: Generate AI Answer
    console.log(`🤖 AI generating answer for ${products.length} products`)

    let answer = ''
    
    if (products.length <= MAX_DETAILED_PRODUCTS) {
      // Detailed analysis for small result sets
      console.log(`⚡ DETAILED ANALYSIS approach (${products.length} products)`)
      
      const productData = await prepareEssentialProductData(products, MAX_DETAILED_PRODUCTS)
      
      const systemPrompt = `You are a helpful product expert. Analyze the products and provide a comprehensive answer.

IMPORTANT FORMATTING RULES:
- Use markdown for structure (headers, lists, tables)
- Be concise but informative
- Highlight key differences when comparing products
- Include product names, SKUs, and key specifications
- If user asks "which products", list them clearly`

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `User Query: "${query}"\n\nProducts:\n${productData}` }
        ],
        temperature: 0.3,
        max_tokens: 2000
      })

      answer = completion.choices[0].message.content || 'Unable to generate answer.'
      
    } else {
      // Summary approach for large result sets
      console.log(`⚡ SUMMARY approach (${products.length} products)`)
      
      const summary = createFamilyGroupedSummary(products)
      
      const systemPrompt = `You are a helpful product expert. Provide a concise summary of the product search results.

IMPORTANT:
- Start with total count
- Group by family/category
- Mention top representatives
- Keep it brief (max 300 words)`

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `User Query: "${query}"\n\nSummary:\n${summary}` }
        ],
        temperature: 0.3,
        max_tokens: 1000
      })

      answer = completion.choices[0].message.content || 'Unable to generate answer.'
    }

    console.log(`✅ Answer generated (${answer.length} chars)`)
    console.log(`${'='.repeat(80)}\n`)

    // Clean products before sending
    const cleanedProducts = products.map(p => cleanProductData(p))

    return NextResponse.json({
      success: true,
      answer,
      products: cleanedProducts,
      intent: plan.intent,
      searchTerms: plan.searchTerms,
      totalResults: products.length
    })

  } catch (error: any) {
    console.error('❌ API Error:', error)
    console.error('   Stack:', error.stack)
    
    return NextResponse.json(
      { 
        success: false,
        error: error.message || 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      },
      { status: 500 }
    )
  }
}
